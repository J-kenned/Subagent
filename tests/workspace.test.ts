import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeConfig, type Config } from "../src/config.js";
import { isWithin, listWorkspaces, resolveWorkspace } from "../src/workspace/resolve.js";
import { discoverContext, partitionForProvider } from "../src/workspace/discover.js";
import { buildBridge } from "../src/workspace/bridge.js";
import { claudeAdapter } from "../src/adapters/claude.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { PolicyError } from "../src/types.js";

let tmp: string;
let cfg: Config;

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(tmp, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-ws-"));
  // realpath: macOS puts tmpdir behind a /private symlink, and the resolver
  // compares real paths.
  tmp = await fs.realpath(tmp);
  await fs.mkdir(path.join(tmp, "roots", "project2"), { recursive: true });
  await fs.mkdir(path.join(tmp, "roots", "project3"), { recursive: true });
  await fs.mkdir(path.join(tmp, "outside"), { recursive: true });
  cfg = mergeConfig(path.join(tmp, "home"), {
    workspaces: { roots: [path.join(tmp, "roots")], named: {} },
  });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("isWithin", () => {
  it("accepts the root itself and its descendants", () => {
    expect(isWithin("/a/b", "/a/b")).toBe(true);
    expect(isWithin("/a/b", "/a/b/c")).toBe(true);
  });

  it("rejects escapes and sibling prefixes", () => {
    expect(isWithin("/a/b", "/a")).toBe(false);
    expect(isWithin("/a/b", "/a/bc")).toBe(false);
  });
});

describe("resolveWorkspace", () => {
  it("resolves a name under a configured root", async () => {
    const ws = await resolveWorkspace(cfg, { workspace: "project2" });
    expect(ws.name).toBe("project2");
    expect(ws.path).toBe(path.join(tmp, "roots", "project2"));
  });

  it("rejects an unknown name with an actionable hint", async () => {
    await expect(resolveWorkspace(cfg, { workspace: "nope" })).rejects.toThrow(PolicyError);
    await expect(resolveWorkspace(cfg, { workspace: "nope" })).rejects.toThrow(/no workspace named/);
  });

  it("rejects a cwd outside every root", async () => {
    await expect(resolveWorkspace(cfg, { cwd: path.join(tmp, "outside") })).rejects.toThrow(
      /outside every configured workspace root/,
    );
  });

  it("refuses to spawn with no workspace or cwd at all", async () => {
    await expect(resolveWorkspace(cfg, {})).rejects.toThrow(/workspace or cwd is required/);
  });

  it("does not let a symlink walk out of an allowlisted root", async () => {
    // The containment check runs after realpath, so a symlink planted inside a
    // root cannot be used to reach a directory outside it.
    await fs.symlink(path.join(tmp, "outside"), path.join(tmp, "roots", "escape"));
    await expect(resolveWorkspace(cfg, { workspace: "escape" })).rejects.toThrow(PolicyError);
  });

  it("honours an explicitly named workspace outside the roots", async () => {
    const named = mergeConfig(cfg.home, {
      workspaces: { roots: [path.join(tmp, "roots")], named: { far: path.join(tmp, "outside") } },
    });
    const ws = await resolveWorkspace(named, { workspace: "far" });
    expect(ws.path).toBe(path.join(tmp, "outside"));
  });

  it("lists every addressable workspace", async () => {
    const all = await listWorkspaces(cfg);
    expect(all.map((w) => w.name)).toEqual(["project2", "project3"]);
  });
});

describe("discoverContext", () => {
  it("finds each vendor's context files and records who reads them", async () => {
    await write("roots/project2/CLAUDE.md", "# claude brief");
    await write("roots/project2/AGENTS.md", "# agents brief");
    await write("roots/project2/.cursor/rules/style.mdc", "cursor rule");
    await write("roots/project2/.kiro/steering/arch.md", "kiro steering");

    const profile = await discoverContext("project2", path.join(tmp, "roots", "project2"));
    const byRel = Object.fromEntries(profile.files.map((f) => [f.rel, f.nativeTo]));

    expect(byRel["CLAUDE.md"]).toEqual(["claude"]);
    expect(byRel["AGENTS.md"]).toEqual(["codex", "cursor"]);
    expect(byRel[path.join(".cursor", "rules", "style.mdc")]).toEqual(["cursor"]);
    expect(byRel[path.join(".kiro", "steering", "arch.md")]).toEqual(["kiro"]);
  });

  it("reports the git branch when there is one", async () => {
    await write("roots/project2/.git/HEAD", "ref: refs/heads/main\n");
    const profile = await discoverContext("project2", path.join(tmp, "roots", "project2"));
    expect(profile.isGitRepo).toBe(true);
    expect(profile.gitBranch).toBe("main");
  });

  it("partitions native vs orphan per provider", async () => {
    await write("roots/project2/CLAUDE.md", "brief");
    const profile = await discoverContext("project2", path.join(tmp, "roots", "project2"));

    expect(partitionForProvider(profile, "claude").native.map((f) => f.rel)).toEqual(["CLAUDE.md"]);
    // The gap the product exists to close.
    expect(partitionForProvider(profile, "codex").orphan.map((f) => f.rel)).toEqual(["CLAUDE.md"]);
  });
});

describe("buildBridge", () => {
  const opts = { enabled: true, maxBytes: 32 * 1024 };

  it("bridges a CLAUDE.md-only repo into codex", async () => {
    // Six of eleven documented repos on the author's machine look exactly like
    // this: without bridging, codex starts with no project context at all.
    await write("roots/project2/CLAUDE.md", "Never use tabs.");
    const profile = await discoverContext("project2", path.join(tmp, "roots", "project2"));

    const bridge = await buildBridge(profile, codexAdapter, opts);
    expect(bridge.via).toBe("prompt-prefix");
    expect(bridge.payload).toContain("Never use tabs.");
    expect(bridge.inherited.bridged.map((b) => b.path)).toEqual(["CLAUDE.md"]);
  });

  it("bridges nothing when the provider reads the file natively", async () => {
    await write("roots/project2/CLAUDE.md", "Never use tabs.");
    const profile = await discoverContext("project2", path.join(tmp, "roots", "project2"));

    const bridge = await buildBridge(profile, claudeAdapter, opts);
    expect(bridge.payload).toBeUndefined();
    expect(bridge.inherited.native).toEqual(["CLAUDE.md"]);
    expect(bridge.inherited.bridged).toEqual([]);
  });

  it("uses the system-prompt channel where the provider has one", async () => {
    await write("roots/project2/.kiro/steering/arch.md", "kiro only");
    const profile = await discoverContext("project2", path.join(tmp, "roots", "project2"));

    const bridge = await buildBridge(profile, claudeAdapter, opts);
    expect(bridge.via).toBe("system-prompt");
    expect(bridge.payload).toContain("kiro only");
  });

  it("labels provenance so the worker can weigh what it was handed", async () => {
    await write("roots/project2/CLAUDE.md", "rules here");
    const profile = await discoverContext("project2", path.join(tmp, "roots", "project2"));
    const bridge = await buildBridge(profile, codexAdapter, opts);
    expect(bridge.payload).toContain('<inherited-context path="CLAUDE.md"');
    expect(bridge.payload).toContain('native-to="claude"');
    expect(bridge.payload).toContain('bridged-to="codex"');
  });

  it("truncates at the byte budget and says so", async () => {
    await write("roots/project2/CLAUDE.md", "x".repeat(5000));
    const profile = await discoverContext("project2", path.join(tmp, "roots", "project2"));

    const bridge = await buildBridge(profile, codexAdapter, { enabled: true, maxBytes: 100 });
    expect(bridge.inherited.truncated).toBe(true);
    expect(bridge.payload).toContain("[truncated");
  });

  it("prefers the project brief over tool-specific rules when space is tight", async () => {
    await write("roots/project2/CLAUDE.md", "the project brief");
    await write("roots/project2/.kiro/steering/arch.md", "kiro detail");
    const profile = await discoverContext("project2", path.join(tmp, "roots", "project2"));

    const bridge = await buildBridge(profile, codexAdapter, { enabled: true, maxBytes: 20 });
    expect(bridge.inherited.bridged[0]?.path).toBe("CLAUDE.md");
  });

  it("bridges nothing when disabled", async () => {
    await write("roots/project2/CLAUDE.md", "brief");
    const profile = await discoverContext("project2", path.join(tmp, "roots", "project2"));

    const bridge = await buildBridge(profile, codexAdapter, { enabled: false, maxBytes: 32 * 1024 });
    expect(bridge.payload).toBeUndefined();
    expect(bridge.inherited.bridged).toEqual([]);
  });
});
