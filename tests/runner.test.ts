import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Runner } from "../src/runtime/runner.js";
import { claudeAdapter } from "../src/adapters/claude.js";
import { readEvents, readMeta } from "../src/runtime/storage.js";
import type { RunMeta, RunSpec } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(here, "fixtures", "fake-claude.mjs");

let tmp: string;
let workspace: string;

function makeMeta(runId: string, over: Partial<RunMeta> = {}): RunMeta {
  const now = Date.now();
  return {
    runId,
    provider: "claude",
    target: "local",
    status: "created",
    permission: "edit",
    cwd: workspace,
    workspace: "ws",
    createdAt: now,
    startedAt: now,
    lastSeq: 0,
    turns: [],
    initialPrompt: "",
    ...over,
  };
}

function makeSpec(runId: string, prompt: string): RunSpec {
  return {
    runId,
    provider: "claude",
    target: "local",
    prompt,
    cwd: workspace,
    permission: "edit",
    extraDirs: [],
  };
}

/**
 * Build a Runner wired to the fixture binary. Every test goes through here so
 * the real adapter argv is always exercised.
 */
function makeRunner(runId: string, over: Partial<RunMeta> = {}): { runner: Runner; meta: RunMeta } {
  const meta = makeMeta(runId, over);
  return { runner: new Runner(meta, wrapAdapterWithScript()), meta };
}

async function start(runner: Runner, runId: string, prompt: string): Promise<void> {
  await runner.startTurn({
    spec: makeSpec(runId, prompt),
    message: prompt,
    kind: "spawn",
    bin: process.execPath,
    env: { PATH: process.env["PATH"] ?? "" },
    preassignedHandle: "preset-session-id",
  });
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "subagent-run-")));
  workspace = path.join(tmp, "ws");
  await fs.mkdir(workspace, { recursive: true });
  process.env["SUBAGENT_HOME"] = path.join(tmp, "home");
  await fs.mkdir(path.join(tmp, "home"), { recursive: true });
});

afterEach(async () => {
  delete process.env["SUBAGENT_HOME"];
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("Runner end to end", () => {
  it("streams, persists, and derives a successful outcome", async () => {
    // The fake binary is invoked as `node <script> ...adapterArgv`, so the
    // adapter's argv is exercised for real.
    const meta = await runWithScript("do the thing");

    expect(meta.status).toBe("completed");
    expect(meta.outcome?.summary).toBe("PROBE_OK");
    expect(meta.outcome?.usage?.costUsd).toBe(0.0042);
    expect(meta.outcome?.artifacts.map((a) => a.ref)).toEqual(["/repo/out.ts"]);
  });

  it("persists normalized events with monotonic sequence numbers", async () => {
    const meta = await runWithScript("do the thing");
    const events = await readEvents(meta.runId, 0, 100);

    expect(events.length).toBeGreaterThan(0);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.every((e) => e.runId === meta.runId)).toBe(true);
    expect(events.map((e) => e.kind)).toContain("result");
    // Raw vendor payloads survive normalization.
    expect(events.every((e) => e.raw !== undefined)).toBe(true);
  });

  it("writes meta to disk so hooks can read it without the server", async () => {
    const meta = await runWithScript("do the thing");
    const onDisk = await readMeta(meta.runId);
    expect(onDisk?.status).toBe("completed");
    expect(onDisk?.summary).toBe("PROBE_OK");
  });

  it("reports failure when the provider exits 0 but signals an error", async () => {
    const meta = await runWithScript("FAIL please");
    expect(meta.status).toBe("failed");
    expect(meta.outcome?.summary).toContain("Not logged in");
    expect(meta.outcome?.terminalReason).toBe("api_error");
  });

  it("uses the preassigned session handle rather than scraping one", async () => {
    const meta = await runWithScript("do the thing");
    expect(meta.sessionHandle).toBe("preset-session-id");
  });

  it("marks a cancelled run cancelled, not failed", async () => {
    const { runner, meta } = makeRunner("run-cancel");
    await start(runner, "run-cancel", "SLOW work");
    await new Promise((r) => setTimeout(r, 150));
    expect(runner.isBusy()).toBe(true);

    await runner.cancel();
    // A killed process looks like a non-zero exit; only the cancelled flag
    // distinguishes a deliberate stop from a crash.
    expect(meta.status).toBe("cancelled");
  });

  it("times out a run that never terminates", async () => {
    const { runner, meta } = makeRunner("run-timeout", { timeoutMs: 200 });
    await start(runner, "run-timeout", "SLOW work");
    await runner.waitIdle();
    expect(meta.status).toBe("timed_out");
  });

  it("refuses a second concurrent turn on the same run", async () => {
    const { runner } = makeRunner("run-busy");
    await start(runner, "run-busy", "SLOW work");
    await expect(start(runner, "run-busy", "SLOW work")).rejects.toThrow(/busy/);
    await runner.cancel();
  });
});

/**
 * Drive the fake binary through the real adapter argv: node runs the fixture
 * script, and everything the adapter appends follows it.
 */
async function runWithScript(prompt: string): Promise<RunMeta> {
  const runId = `run-${Math.abs(hash(prompt))}`;
  const meta = makeMeta(runId);
  const runner = new Runner(meta, wrapAdapterWithScript(), {});
  await runner.startTurn({
    spec: makeSpec(runId, prompt),
    message: prompt,
    kind: "spawn",
    bin: process.execPath,
    env: { PATH: process.env["PATH"] ?? "" },
    preassignedHandle: "preset-session-id",
  });
  await runner.waitIdle();
  return meta;
}

/** claude adapter, with the fixture script injected ahead of its argv. */
function wrapAdapterWithScript(): typeof claudeAdapter {
  return {
    ...claudeAdapter,
    plan(spec, ctx, env) {
      const inv = claudeAdapter.plan(spec, ctx, env);
      if (inv.transport !== "cli") throw new Error("expected cli");
      return { ...inv, argv: [FAKE_CLAUDE, ...inv.argv] };
    },
  };
}
