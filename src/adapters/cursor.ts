import type {
  AdapterEnv,
  AgentAdapter,
  AuthState,
  Capabilities,
  Invocation,
  OutcomeInput,
  PlanContext,
  StreamParser,
} from "./types.js";
import type { Artifact, DraftEvent, Outcome, RunSpec } from "../types.js";
import { NdjsonSplitter, probe, tail, withBridgedPrefix } from "./util.js";

const capabilities: Capabilities = {
  stream: "ndjson",
  sessionHandle: "scraped",
  resume: true,
  followUp: true,
  permissionTiers: ["read", "edit", "auto", "bypass"],
  extraDirs: false,
  systemPromptAppend: false,
  namedAgents: false,
  structuredOutput: false,
  spendCap: false,
  worktree: true,
  nativeContextFiles: ["AGENTS.md", ".cursor/rules", ".cursorrules"],
};

interface CursorToolCall {
  editToolCall?: {
    args?: { path?: string };
    result?: {
      success?: { path?: string; linesAdded?: number; linesRemoved?: number; diffString?: string };
    };
  };
  shellToolCall?: {
    args?: { command?: string };
    result?: {
      success?: { command?: string; exitCode?: number; stdout?: string; stderr?: string };
    };
  };
}

function textFromMessage(message: unknown): string | undefined {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((c) => (c && typeof c === "object" ? String((c as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean);
  return parts.length ? parts.join("") : undefined;
}

class CursorParser implements StreamParser {
  private readonly splitter = new NdjsonSplitter();
  private handle: string | undefined;

  push(chunk: string): DraftEvent[] {
    return this.map(this.splitter.push(chunk));
  }

  flush(): DraftEvent[] {
    return this.map(this.splitter.flush());
  }

  sessionHandle(): string | undefined {
    return this.handle;
  }

  private map(raws: unknown[]): DraftEvent[] {
    const out: DraftEvent[] = [];
    for (const raw of raws) {
      const ev = raw as Record<string, unknown>;
      const sid = ev["chat_id"] ?? ev["chatId"] ?? ev["session_id"];
      if (typeof sid === "string" && !this.handle) this.handle = sid;

      switch (ev["type"]) {
        case "assistant": {
          // Cursor emits incremental deltas carrying `timestamp_ms` plus one
          // consolidated message per turn without it. Only the consolidated
          // message is worth keeping as text; deltas are noise at this layer.
          if (ev["timestamp_ms"] !== undefined) {
            out.push({ kind: "lifecycle", text: "delta", raw });
            break;
          }
          const text = textFromMessage(ev["message"]);
          out.push(text ? { kind: "text", text, raw } : { kind: "lifecycle", text: "assistant", raw });
          break;
        }

        case "tool_call": {
          const tc = ev["tool_call"] as CursorToolCall | undefined;
          const done = ev["subtype"] === "completed";
          const name = tc?.editToolCall ? "edit" : tc?.shellToolCall ? "shell" : "tool";
          out.push(
            done
              ? {
                  kind: "tool_result",
                  tool: {
                    name,
                    output: tc?.shellToolCall?.result?.success?.stdout ?? tc?.editToolCall?.result?.success?.path,
                    ok: (tc?.shellToolCall?.result?.success?.exitCode ?? 0) === 0,
                  },
                  raw,
                }
              : {
                  kind: "tool_call",
                  tool: { name, input: tc?.shellToolCall?.args ?? tc?.editToolCall?.args },
                  raw,
                },
          );
          break;
        }

        case "result":
          out.push({ kind: "result", text: String(ev["result"] ?? ""), raw });
          break;

        default:
          out.push({
            kind: "lifecycle",
            text: typeof ev["type"] === "string" ? ev["type"] : undefined,
            ...(typeof sid === "string" ? { sessionHandle: sid } : {}),
            raw,
          });
      }
    }
    return out;
  }
}

export const cursorAdapter: AgentAdapter = {
  id: "cursor",
  displayName: "Cursor Agent",
  transport: "cli",
  capabilities,
  defaultBin: "cursor-agent",
  envAllowlist: ["PATH", "HOME", "SHELL", "LANG", "TERM", "TMPDIR", "CURSOR_API_KEY"],

  async preflight(env: AdapterEnv): Promise<AuthState> {
    const version = await probe(env.bin, ["--version"], env.env);
    if (version.missing) {
      return {
        installed: false,
        authenticated: false,
        reason: `${env.bin} not found on PATH`,
        remedy: "Install Cursor CLI — https://cursor.com/docs/cli/overview",
      };
    }
    if (process.env["CURSOR_API_KEY"]) {
      return { installed: true, authenticated: true, method: "CURSOR_API_KEY" };
    }
    const status = await probe(env.bin, ["status"], env.env, 15_000);
    const blob = `${status.stdout}${status.stderr}`;
    if (status.ok && !/not logged in|logged out|no auth/i.test(blob)) {
      const email = blob.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0];
      return { installed: true, authenticated: true, method: "login", ...(email ? { account: email } : {}) };
    }
    return {
      installed: true,
      authenticated: false,
      reason: tail(blob, 200) || "not logged in",
      remedy: "Run `cursor-agent login` (or set CURSOR_API_KEY)",
    };
  },

  plan(spec: RunSpec, ctx: PlanContext, env: AdapterEnv): Invocation {
    const argv = ["-p", "--output-format", "stream-json", "--workspace", spec.cwd];

    if (spec.model) argv.push("--model", spec.model);

    // Cursor expresses permission through mode + trust + force rather than a
    // single tier flag.
    switch (spec.permission) {
      case "read":
        argv.push("--mode", "plan", "--sandbox", "enabled");
        break;
      case "edit":
        argv.push("--sandbox", "enabled");
        break;
      case "auto":
        argv.push("--trust", "--sandbox", "enabled");
        break;
      case "bypass":
        argv.push("--trust", "--force", "--sandbox", "disabled");
        break;
    }

    if (ctx.kind === "resume" && spec.sessionHandle) argv.push("--resume", spec.sessionHandle);

    argv.push(withBridgedPrefix(spec.prompt, ctx.bridgedContext));

    return { transport: "cli", bin: env.bin, argv, cwd: spec.cwd, env: env.env };
  },

  createParser(): StreamParser {
    return new CursorParser();
  },

  deriveOutcome(input: OutcomeInput): Outcome {
    if (input.cancelled) {
      return { status: "cancelled", summary: "Run cancelled.", artifacts: [], openQuestions: [] };
    }
    if (input.timedOut) {
      return { status: "timed_out", summary: "Run exceeded its timeout.", artifacts: [], openQuestions: [] };
    }

    const lastResult = [...input.events].reverse().find((e) => e.kind === "result")?.text;
    const lastText = [...input.events].reverse().find((e) => e.kind === "text")?.text ?? "";
    const failed = input.exitCode !== null && input.exitCode !== 0;

    return {
      status: failed ? "failed" : "completed",
      summary: (lastText || lastResult || tail(input.stderrTail, 500)).slice(0, 4000),
      artifacts: collectArtifacts(input.events),
      openQuestions: [],
      ...(failed ? { terminalReason: `exit ${input.exitCode}` } : {}),
    };
  },
};

function collectArtifacts(events: OutcomeInput["events"]): Artifact[] {
  const out: Artifact[] = [];
  for (const ev of events) {
    if (ev.kind !== "tool_result") continue;
    const raw = ev.raw as { tool_call?: CursorToolCall } | undefined;
    const tc = raw?.tool_call;
    if (tc?.editToolCall?.result?.success) {
      const s = tc.editToolCall.result.success;
      out.push({
        artifactId: `edit-${ev.seq}`,
        type: "file",
        ref: s.path ?? tc.editToolCall.args?.path ?? "",
        metadata: { linesAdded: s.linesAdded, linesRemoved: s.linesRemoved, diff: s.diffString },
      });
    } else if (tc?.shellToolCall?.result?.success) {
      const s = tc.shellToolCall.result.success;
      out.push({
        artifactId: `shell-${ev.seq}`,
        type: "log",
        ref: s.command ?? tc.shellToolCall.args?.command ?? "",
        metadata: { exitCode: s.exitCode, stdout: s.stdout, stderr: s.stderr },
      });
    }
  }
  return out;
}
