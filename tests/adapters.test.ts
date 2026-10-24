import { describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/adapters/claude.js";
import { cursorAdapter } from "../src/adapters/cursor.js";
import { kiroAdapter } from "../src/adapters/kiro.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { NdjsonSplitter } from "../src/adapters/util.js";
import type { OutcomeInput } from "../src/adapters/types.js";
import type { DraftEvent } from "../src/types.js";

/** Feed drafts into the shape deriveOutcome expects. */
function toOutcomeEvents(drafts: DraftEvent[]): OutcomeInput["events"] {
  return drafts.map((d, i) => ({ seq: i + 1, kind: d.kind, ...(d.text ? { text: d.text } : {}), raw: d.raw }));
}

function baseOutcomeInput(drafts: DraftEvent[], overrides: Partial<OutcomeInput> = {}): OutcomeInput {
  return {
    events: toOutcomeEvents(drafts),
    exitCode: 0,
    stderrTail: "",
    cancelled: false,
    timedOut: false,
    ...overrides,
  };
}

describe("NdjsonSplitter", () => {
  it("reassembles objects split across chunk boundaries", () => {
    const s = new NdjsonSplitter();
    expect(s.push('{"a":')).toEqual([]);
    expect(s.push('1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("retains unparseable output instead of dropping it", () => {
    const s = new NdjsonSplitter();
    expect(s.push("not json\n")).toEqual([{ __unparsed: "not json" }]);
  });

  it("flushes a trailing line with no newline", () => {
    const s = new NdjsonSplitter();
    s.push('{"a":1}');
    expect(s.flush()).toEqual([{ a: 1 }]);
  });
});

describe("claude adapter", () => {
  // Captured from a live `claude -p --output-format stream-json --verbose` run.
  const initEvent = JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "8a8a00e3-46b6-4542-8b70-3ecd6b499d7e",
    model: "claude-haiku-4-5-20251001",
  });
  const assistantEvent = JSON.stringify({
    type: "assistant",
    session_id: "8a8a00e3-46b6-4542-8b70-3ecd6b499d7e",
    message: { role: "assistant", content: [{ type: "text", text: "PROBE_OK" }] },
  });

  it("captures the session handle from the stream", () => {
    const parser = claudeAdapter.createParser();
    parser.push(`${initEvent}\n`);
    expect(parser.sessionHandle()).toBe("8a8a00e3-46b6-4542-8b70-3ecd6b499d7e");
  });

  it("maps assistant text and tool_use into distinct events", () => {
    const parser = claudeAdapter.createParser();
    const withTool = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Write", input: { file_path: "/tmp/x.ts" } },
          { type: "text", text: "done" },
        ],
      },
    });
    const events = parser.push(`${withTool}\n`);
    expect(events.map((e) => e.kind)).toEqual(["tool_call", "text"]);
    expect(events[0]?.tool?.name).toBe("Write");
    expect(events[1]?.text).toBe("done");
  });

  it("reports failure from result.is_error even when the process exits 0", () => {
    // Verified live: claude exits 0 while signalling failure only in the
    // result event. Trusting the exit code would report this as completed.
    const parser = claudeAdapter.createParser();
    const drafts = [
      ...parser.push(`${initEvent}\n`),
      ...parser.push(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: true,
          result: "Not logged in · Please run /login",
          terminal_reason: "api_error",
        })}\n`,
      ),
    ];

    const outcome = claudeAdapter.deriveOutcome(baseOutcomeInput(drafts, { exitCode: 0 }));
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("Not logged in");
    expect(outcome.terminalReason).toBe("api_error");
  });

  it("reports success and usage from a clean result", () => {
    const parser = claudeAdapter.createParser();
    const drafts = [
      ...parser.push(`${initEvent}\n${assistantEvent}\n`),
      ...parser.push(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "PROBE_OK",
          total_cost_usd: 0.0012,
          usage: { input_tokens: 10, output_tokens: 4 },
        })}\n`,
      ),
    ];
    const outcome = claudeAdapter.deriveOutcome(baseOutcomeInput(drafts));
    expect(outcome.status).toBe("completed");
    expect(outcome.summary).toBe("PROBE_OK");
    expect(outcome.usage?.costUsd).toBe(0.0012);
  });

  it("collects edited files as artifacts", () => {
    const parser = claudeAdapter.createParser();
    const drafts = parser.push(
      `${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/repo/a.ts" } }] },
      })}\n`,
    );
    const outcome = claudeAdapter.deriveOutcome(baseOutcomeInput(drafts));
    expect(outcome.artifacts.map((a) => a.ref)).toEqual(["/repo/a.ts"]);
  });

  it("fails when the stream ends with no result event", () => {
    const parser = claudeAdapter.createParser();
    const drafts = parser.push(`${initEvent}\n`);
    const outcome = claudeAdapter.deriveOutcome(baseOutcomeInput(drafts, { exitCode: 1, stderrTail: "boom" }));
    expect(outcome.status).toBe("failed");
    expect(outcome.terminalReason).toBe("stream ended without a result event");
  });

  it("builds argv with the flags the CLI actually requires", () => {
    const inv = claudeAdapter.plan(
      {
        runId: "r1",
        provider: "claude",
        target: "local",
        prompt: "do the thing",
        cwd: "/repo",
        permission: "edit",
        extraDirs: ["/other"],
        model: "opus",
      },
      { kind: "spawn", preassignedHandle: "sess-1", bridgedContext: "CTX" },
      { bin: "claude", env: {} },
    );
    if (inv.transport !== "cli") throw new Error("expected cli");
    // Verified: -p + stream-json is rejected outright without --verbose.
    expect(inv.argv).toContain("--verbose");
    expect(inv.argv).toContain("--session-id");
    expect(inv.argv[inv.argv.indexOf("--session-id") + 1]).toBe("sess-1");
    expect(inv.argv[inv.argv.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(inv.argv[inv.argv.indexOf("--add-dir") + 1]).toBe("/other");
    // Claude has a real system-prompt channel, so bridged context goes there
    // rather than being stuffed into the user prompt.
    expect(inv.argv[inv.argv.indexOf("--append-system-prompt") + 1]).toBe("CTX");
    expect(inv.argv.at(-1)).toBe("do the thing");
  });

  it("maps every permission tier to a distinct mode", () => {
    const modes = (["read", "edit", "auto", "bypass"] as const).map((permission) => {
      const inv = claudeAdapter.plan(
        { runId: "r", provider: "claude", target: "local", prompt: "p", cwd: "/repo", permission, extraDirs: [] },
        { kind: "spawn" },
        { bin: "claude", env: {} },
      );
      if (inv.transport !== "cli") throw new Error("expected cli");
      return inv.argv[inv.argv.indexOf("--permission-mode") + 1];
    });
    expect(modes).toEqual(["plan", "acceptEdits", "auto", "bypassPermissions"]);
    expect(new Set(modes).size).toBe(4);
  });
});

describe("cursor adapter", () => {
  it("scrapes chat_id and ignores delta noise", () => {
    const parser = cursorAdapter.createParser();
    const events = parser.push(
      [
        JSON.stringify({ type: "system", chat_id: "chat-9" }),
        // Deltas carry timestamp_ms; only the consolidated message is text.
        JSON.stringify({ type: "assistant", timestamp_ms: 1, message: { content: [{ text: "par" }] } }),
        JSON.stringify({ type: "assistant", message: { content: [{ text: "final answer" }] } }),
        "",
      ].join("\n"),
    );
    expect(parser.sessionHandle()).toBe("chat-9");
    const texts = events.filter((e) => e.kind === "text").map((e) => e.text);
    expect(texts).toEqual(["final answer"]);
  });

  it("turns completed edit tool calls into file artifacts", () => {
    const parser = cursorAdapter.createParser();
    const drafts = parser.push(
      `${JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        tool_call: {
          editToolCall: { args: { path: "/repo/x.ts" }, result: { success: { path: "/repo/x.ts", linesAdded: 3 } } },
        },
      })}\n`,
    );
    const outcome = cursorAdapter.deriveOutcome(baseOutcomeInput(drafts));
    expect(outcome.artifacts[0]).toMatchObject({ type: "file", ref: "/repo/x.ts" });
  });

  it("expresses permission through mode, trust, and force", () => {
    const argvFor = (permission: "read" | "edit" | "auto" | "bypass"): string[] => {
      const inv = cursorAdapter.plan(
        { runId: "r", provider: "cursor", target: "local", prompt: "p", cwd: "/repo", permission, extraDirs: [] },
        { kind: "spawn" },
        { bin: "cursor-agent", env: {} },
      );
      if (inv.transport !== "cli") throw new Error("expected cli");
      return inv.argv;
    };
    expect(argvFor("read")).toContain("plan");
    expect(argvFor("edit")).not.toContain("--trust");
    expect(argvFor("auto")).toContain("--trust");
    expect(argvFor("bypass")).toContain("--force");
  });

  it("puts bridged context in the prompt, having no system-prompt channel", () => {
    const inv = cursorAdapter.plan(
      { runId: "r", provider: "cursor", target: "local", prompt: "TASK", cwd: "/repo", permission: "edit", extraDirs: [] },
      { kind: "spawn", bridgedContext: "INHERITED" },
      { bin: "cursor-agent", env: {} },
    );
    if (inv.transport !== "cli") throw new Error("expected cli");
    expect(inv.argv.at(-1)).toContain("INHERITED");
    expect(inv.argv.at(-1)).toContain("TASK");
  });
});

describe("kiro adapter", () => {
  it("declares its limits rather than faking them", () => {
    // Text-only stream and no headless session id (kirodotdev/Kiro#9066).
    expect(kiroAdapter.capabilities.stream).toBe("text");
    expect(kiroAdapter.capabilities.sessionHandle).toBe("none");
    expect(kiroAdapter.capabilities.followUp).toBe(false);
  });

  it("buffers stdout and synthesizes text + result at close", () => {
    const parser = kiroAdapter.createParser();
    expect(parser.push("partial ")).toEqual([]);
    expect(parser.push("answer")).toEqual([]);
    const flushed = parser.flush();
    expect(flushed.map((e) => e.kind)).toEqual(["text", "result"]);
    expect(flushed[1]?.text).toBe("partial answer");
  });

  it("maps permission tiers onto trust flags", () => {
    const argvFor = (permission: "read" | "edit" | "auto" | "bypass"): string[] => {
      const inv = kiroAdapter.plan(
        { runId: "r", provider: "kiro", target: "local", prompt: "p", cwd: "/repo", permission, extraDirs: [] },
        { kind: "spawn" },
        { bin: "kiro-cli", env: {} },
      );
      if (inv.transport !== "cli") throw new Error("expected cli");
      return inv.argv;
    };
    expect(argvFor("read")).toContain("--trust-tools=");
    expect(argvFor("edit")).toContain("--trust-tools=fs_read,fs_write");
    expect(argvFor("bypass")).toContain("--trust-all-tools");
    expect(argvFor("auto")).toContain("--no-interactive");
  });
});

describe("codex adapter", () => {
  it("accepts both the flat and nested event envelopes", () => {
    const parser = codexAdapter.createParser();
    const flat = parser.push(`${JSON.stringify({ type: "agent_message", message: "hello" })}\n`);
    const nested = parser.push(`${JSON.stringify({ msg: { type: "agent_message", message: "world" } })}\n`);
    expect(flat.find((e) => e.kind === "text")?.text).toBe("hello");
    expect(nested.find((e) => e.kind === "text")?.text).toBe("world");
  });

  it("routes resume through the exec subcommand", () => {
    const inv = codexAdapter.plan(
      {
        runId: "r",
        provider: "codex",
        target: "local",
        prompt: "follow up",
        cwd: "/repo",
        permission: "edit",
        extraDirs: [],
        sessionHandle: "sess-7",
      },
      { kind: "resume" },
      { bin: "codex", env: {} },
    );
    if (inv.transport !== "cli") throw new Error("expected cli");
    expect(inv.argv.slice(0, 3)).toEqual(["exec", "resume", "sess-7"]);
  });

  it("maps permission tiers onto sandbox levels", () => {
    const sandboxFor = (permission: "read" | "edit" | "bypass"): string | undefined => {
      const inv = codexAdapter.plan(
        { runId: "r", provider: "codex", target: "local", prompt: "p", cwd: "/repo", permission, extraDirs: [] },
        { kind: "spawn" },
        { bin: "codex", env: {} },
      );
      if (inv.transport !== "cli") throw new Error("expected cli");
      return inv.argv[inv.argv.indexOf("--sandbox") + 1];
    };
    expect(sandboxFor("read")).toBe("read-only");
    expect(sandboxFor("edit")).toBe("workspace-write");
    expect(sandboxFor("bypass")).toBe("danger-full-access");
  });

  it("passes --skip-git-repo-check so non-git workspaces are dispatchable", () => {
    const inv = codexAdapter.plan(
      { runId: "r", provider: "codex", target: "local", prompt: "p", cwd: "/repo", permission: "read", extraDirs: [] },
      { kind: "spawn" },
      { bin: "codex", env: {} },
    );
    if (inv.transport !== "cli") throw new Error("expected cli");
    expect(inv.argv).toContain("--skip-git-repo-check");
  });
});

describe("outcome derivation across providers", () => {
  const adapters = [claudeAdapter, codexAdapter, cursorAdapter, kiroAdapter];

  it("honours cancellation and timeout ahead of any stream signal", () => {
    for (const adapter of adapters) {
      expect(adapter.deriveOutcome(baseOutcomeInput([], { cancelled: true })).status).toBe("cancelled");
      expect(adapter.deriveOutcome(baseOutcomeInput([], { timedOut: true })).status).toBe("timed_out");
    }
  });
});
