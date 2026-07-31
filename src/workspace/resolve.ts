import { promises as fs } from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import { expandHome } from "../config.js";
import { PolicyError } from "../types.js";

export interface ResolvedWorkspace {
  /** The name callers used, or the basename when a raw path was given. */
  name: string;
  path: string;
  /** Which configured root authorised this path. */
  root: string;
}

/** True when `child` is `parent` or lives beneath it. Both must be real paths. */
export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function realpathOrThrow(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    throw new PolicyError(
      `path does not exist: ${p}`,
      "Check the workspace name, or pass an existing directory as `cwd`.",
    );
  }
}

async function assertDirectory(p: string): Promise<void> {
  const stat = await fs.stat(p);
  if (!stat.isDirectory()) throw new PolicyError(`not a directory: ${p}`);
}

/**
 * Resolve a workspace name or raw path to an allowlisted absolute directory.
 *
 * Resolution order: named workspaces, then a single-level scan of each root.
 * Every result is `realpath`d before the containment check, so a symlink cannot
 * be used to walk out of an allowlisted root.
 */
export async function resolveWorkspace(
  cfg: Config,
  input: { workspace?: string; cwd?: string },
): Promise<ResolvedWorkspace> {
  const roots = await realRoots(cfg);

  if (input.workspace) {
    const named = cfg.workspaces.named[input.workspace];
    if (named) {
      const real = await realpathOrThrow(expandHome(named));
      await assertDirectory(real);
      // Named workspaces are an explicit grant, so they authorise themselves
      // even when they sit outside every configured root.
      const root = roots.find((r) => isWithin(r, real)) ?? real;
      return { name: input.workspace, path: real, root };
    }

    for (const root of roots) {
      const candidate = path.join(root, input.workspace);
      try {
        const real = await fs.realpath(candidate);
        await assertDirectory(real);
        if (isWithin(root, real)) return { name: input.workspace, path: real, root };
      } catch {
        continue;
      }
    }

    throw new PolicyError(
      `no workspace named "${input.workspace}"`,
      roots.length
        ? `Searched: ${roots.join(", ")}. Add it to workspaces.named in ~/.subagent/config.json, or call list_workspaces to see what is addressable.`
        : "No workspace roots are configured. Add workspaces.roots to ~/.subagent/config.json.",
    );
  }

  if (input.cwd) {
    const real = await realpathOrThrow(expandHome(input.cwd));
    await assertDirectory(real);
    const root = roots.find((r) => isWithin(r, real));
    if (!root) {
      throw new PolicyError(
        `cwd is outside every configured workspace root: ${real}`,
        roots.length
          ? `Allowed roots: ${roots.join(", ")}`
          : "No workspace roots are configured. Add workspaces.roots to ~/.subagent/config.json.",
      );
    }
    return { name: path.basename(real), path: real, root };
  }

  throw new PolicyError(
    "a workspace or cwd is required",
    "Autonomous agents are never spawned in an implicit directory. Call list_workspaces to see what is addressable.",
  );
}

async function realRoots(cfg: Config): Promise<string[]> {
  const out: string[] = [];
  for (const root of cfg.workspaces.roots) {
    try {
      out.push(await fs.realpath(expandHome(root)));
    } catch {
      // A configured root that no longer exists is ignored rather than fatal —
      // one stale entry should not take the whole server down.
    }
  }
  return out;
}

/** Every addressable workspace: named entries plus one level under each root. */
export async function listWorkspaces(cfg: Config): Promise<ResolvedWorkspace[]> {
  const out = new Map<string, ResolvedWorkspace>();

  for (const [name, target] of Object.entries(cfg.workspaces.named)) {
    try {
      const real = await fs.realpath(expandHome(target));
      out.set(real, { name, path: real, root: real });
    } catch {
      continue;
    }
  }

  for (const root of await realRoots(cfg)) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".")) continue;
      const full = path.join(root, entry.name);
      try {
        const real = await fs.realpath(full);
        if (!isWithin(root, real)) continue;
        if (!out.has(real)) out.set(real, { name: entry.name, path: real, root });
      } catch {
        continue;
      }
    }
  }

  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
