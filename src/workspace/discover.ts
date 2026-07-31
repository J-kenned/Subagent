import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProviderId } from "../types.js";

export type ContextKind =
  | "claude-md"
  | "agents-md"
  | "cursor-rules"
  | "kiro-steering"
  | "copilot-instructions";

export interface ContextFile {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the workspace, for display. */
  rel: string;
  kind: ContextKind;
  bytes: number;
  /** Providers that discover this file unaided. */
  nativeTo: ProviderId[];
}

export interface ContextProfile {
  workspace: string;
  path: string;
  gitBranch?: string;
  isGitRepo: boolean;
  files: ContextFile[];
}

/** Which providers read which files. The source of truth for bridging. */
const NATIVE: Record<ContextKind, ProviderId[]> = {
  "claude-md": ["claude"],
  "agents-md": ["codex", "cursor"],
  "cursor-rules": ["cursor"],
  "kiro-steering": ["kiro"],
  "copilot-instructions": [],
};

const FLAT_FILES: Array<{ name: string; kind: ContextKind }> = [
  { name: "CLAUDE.md", kind: "claude-md" },
  { name: "CLAUDE.local.md", kind: "claude-md" },
  { name: "AGENTS.md", kind: "agents-md" },
  { name: ".cursorrules", kind: "cursor-rules" },
];

const DIR_GLOBS: Array<{ dir: string; ext: string[]; kind: ContextKind }> = [
  { dir: ".cursor/rules", ext: [".mdc", ".md"], kind: "cursor-rules" },
  { dir: ".kiro/steering", ext: [".md"], kind: "kiro-steering" },
];

const NESTED_FILES: Array<{ rel: string; kind: ContextKind }> = [
  { rel: ".github/copilot-instructions.md", kind: "copilot-instructions" },
];

async function statFile(abs: string): Promise<number | undefined> {
  try {
    const s = await fs.stat(abs);
    return s.isFile() ? s.size : undefined;
  } catch {
    return undefined;
  }
}

async function readDirFiles(abs: string, exts: string[]): Promise<string[]> {
  try {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && exts.includes(path.extname(e.name)))
      .map((e) => path.join(abs, e.name))
      .sort();
  } catch {
    return [];
  }
}

async function gitInfo(dir: string): Promise<{ isRepo: boolean; branch?: string }> {
  try {
    const head = await fs.readFile(path.join(dir, ".git", "HEAD"), "utf8");
    const branch = head.trim().match(/^ref: refs\/heads\/(.+)$/)?.[1];
    return branch ? { isRepo: true, branch } : { isRepo: true };
  } catch {
    return { isRepo: false };
  }
}

/**
 * Discover every agent-context file in a workspace.
 *
 * This is what makes "spawn in that dir" more than a cwd setting: the working
 * directory is the context payload, and this function is what makes that
 * payload legible before a single token is spent.
 */
export async function discoverContext(workspace: string, dir: string): Promise<ContextProfile> {
  const files: ContextFile[] = [];

  const add = (abs: string, kind: ContextKind, bytes: number): void => {
    files.push({ path: abs, rel: path.relative(dir, abs), kind, bytes, nativeTo: NATIVE[kind] });
  };

  for (const { name, kind } of FLAT_FILES) {
    const abs = path.join(dir, name);
    const bytes = await statFile(abs);
    if (bytes !== undefined) add(abs, kind, bytes);
  }

  for (const { rel, kind } of NESTED_FILES) {
    const abs = path.join(dir, rel);
    const bytes = await statFile(abs);
    if (bytes !== undefined) add(abs, kind, bytes);
  }

  for (const { dir: sub, ext, kind } of DIR_GLOBS) {
    for (const abs of await readDirFiles(path.join(dir, sub), ext)) {
      const bytes = await statFile(abs);
      if (bytes !== undefined) add(abs, kind, bytes);
    }
  }

  const git = await gitInfo(dir);
  return {
    workspace,
    path: dir,
    isGitRepo: git.isRepo,
    ...(git.branch ? { gitBranch: git.branch } : {}),
    files,
  };
}

/**
 * Split a profile for a target provider.
 *
 * `native` files the provider finds by itself; `orphan` files are invisible to
 * it and are the bridging candidates.
 */
export function partitionForProvider(
  profile: ContextProfile,
  provider: ProviderId,
): { native: ContextFile[]; orphan: ContextFile[] } {
  const native: ContextFile[] = [];
  const orphan: ContextFile[] = [];
  for (const file of profile.files) {
    (file.nativeTo.includes(provider) ? native : orphan).push(file);
  }
  return { native, orphan };
}
