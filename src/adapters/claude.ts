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
import type { Artifact, DraftEvent, Outcome, PermissionTier, RunSpec } from "../types.js";
import { NdjsonSplitter, probe, tail } from "./util.js";

const capabilities: Capabilities = {
  stream: "ndjson",
  // `--session-id <uuid>` lets us choose the handle up front, so resume never
  // depends on successfully scraping it out of the stream.
  sessionHandle: "preassigned",
  resume: true,
  followUp: true,
  permissionTiers: ["read", "edit", "auto", "bypass"],
  extraDirs: true,
  systemPromptAppend: true,
  namedAgents: true,
  structuredOutput: true,
  spendCap: true,
  worktree: true,
  nativeContextFiles: ["CLAUDE.md", "CLAUDE.local.md"],
};

const PERMISSION_FLAG: Record<PermissionTier, string> = {
  read: "plan",
  edit: "acceptEdits",
  auto: "auto",
  bypass: "bypassPermissions",
};

interface ClaudeResultEvent {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  terminal_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

function textFromMessage(message: unknown): string | undefined {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((c): c is { type: string; text: string } => {
      return !!c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string";
    })
    .map((c) => c.text);
  return parts.length ? parts.join("") : undefined;
}

class ClaudeParser implements StreamParser {
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
      const sid = ev["session_id"];
      if (typeof sid === "string" && !this.handle) this.handle = sid;

      switch (ev["type"]) {
        case "system":
          out.push({
            kind: "lifecycle",
            text: String(ev["subtype"] ?? "system"),
            ...(typeof sid === "string" ? { sessionHandle: sid } : {}),
            raw,
          });
          break;

        case "assistant": {
          const text = textFromMessage(ev["message"]);
          const toolUses = toolUsesFrom(ev["message"]);
          for (const t of toolUses) {
            out.push({ kind: "tool_call", tool: { name: t.name, input: t.input }, raw });
          }
          if (text) out.push({ kind: "text", text, raw });
          if (!text && !toolUses.length) out.push({ kind: "lifecycle", text: "assistant", raw });
          break;
        }

        case "user": {
          const results = toolResultsFrom(ev["message"]);
          for (const r of results) {
            out.push({ kind: "tool_result", tool: { name: r.name, output: r.output, ok: r.ok }, raw });
          }
          if (!results.length) out.push({ kind: "lifecycle", text: "user", raw });
          break;
        }

        case "result": {
          const r = raw as ClaudeResultEvent;
          out.push({
            kind: "result",
            text: r.result ?? "",
            usage: {
              inputTokens: r.usage?.input_tokens,
              outputTokens: r.usage?.output_tokens,
              cacheReadTokens: r.usage?.cache_read_input_tokens,
              costUsd: r.total_cost_usd,
            },
            raw,
          });
          break;
        }

        default:
          out.push({ kind: "lifecycle", raw });
      }
    }
    return out;
  }
}

function toolUsesFrom(message: unknown): Array<{ name: string; input: unknown }> {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((c): c is { type: string; name: string; input: unknown } => {
      return !!c && typeof c === "object" && (c as { type?: string }).type === "tool_use";
    })
    .map((c) => ({ name: c.name, input: c.input }));
}

function toolResultsFrom(message: unknown): Array<{ name: string; output: unknown; ok: boolean }> {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((c): c is { type: string; content?: unknown; is_error?: boolean } => {
      return !!c && typeof c === "object" && (c as { type?: string }).type === "tool_result";
    })
    .map((c) => ({ name: "tool_result", output: c.content, ok: c.is_error !== true }));
}

export const claudeAdapter: AgentAdapter = {
  id: "claude",
  displayName: "Claude Code",
  transport: "cli",
  capabilities,
  defaultBin: "claude",
  envAllowlist: [
    "PATH",
    "HOME",
    "SHELL",
    "LANG",
    "TERM",
    "TMPDIR",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "AWS_REGION",
    "AWS_PROFILE",
  ],

  async preflight(env: AdapterEnv): Promise<AuthState> {
    const version = await probe(env.bin, ["--version"], env.env);
    if (version.missing) {
      return {
        installed: false,
        authenticated: false,
        reason: `${env.bin} not found on PATH`,
        remedy: "Install Claude Code, then re-run. See https://code.claude.com/docs",
      };
    }
    if (process.env["ANTHROPIC_API_KEY"]) {
      return { installed: true, authenticated: true, method: "ANTHROPIC_API_KEY" };
    }
    // `claude auth` reports login state without starting a session.
    const auth = await probe(env.bin, ["auth"], env.env, 15_000);
    const blob = `${auth.stdout}${auth.stderr}`;
    const loggedOut = /not logged in|please run \/login|no credentials/i.test(blob);
    if (auth.ok && !loggedOut) {
      return { installed: true, authenticated: true, method: "oauth" };
    }
    return {
      installed: true,
      authenticated: false,
      reason: loggedOut ? "not logged in" : tail(blob, 200) || "auth state unknown",
      remedy: "Run `claude auth` (or set ANTHROPIC_API_KEY)",
    };
  },

  plan(spec: RunSpec, ctx: PlanContext, env: AdapterEnv): Invocation {
    const argv = [
      "-p",
      "--output-format",
      "stream-json",
      // Verified: `-p` + stream-json is rejected outright without --verbose.
      "--verbose",
      "--permission-mode",
      PERMISSION_FLAG[spec.permission],
    ];

    if (ctx.kind === "resume") {
      const handle = spec.sessionHandle ?? ctx.preassignedHandle;
      if (handle) argv.push("--resume", handle);
    } else if (ctx.preassignedHandle) {
      argv.push("--session-id", ctx.preassignedHandle);
    }

    if (spec.model) argv.push("--model", spec.model);
    if (spec.agent) argv.push("--agent", spec.agent);
    if (spec.maxBudgetUsd) argv.push("--max-budget-usd", String(spec.maxBudgetUsd));
    for (const dir of spec.extraDirs) argv.push("--add-dir", dir);

    // Claude has a real out-of-band system prompt channel, so bridged context
    // never has to consume the user prompt or pollute the transcript.
    if (ctx.bridgedContext) argv.push("--append-system-prompt", ctx.bridgedContext);

    argv.push(spec.prompt);

    return { transport: "cli", bin: env.bin, argv, cwd: spec.cwd, env: env.env };
  },

  createParser(): StreamParser {
    return new ClaudeParser();
  },

  deriveOutcome(input: OutcomeInput): Outcome {
    if (input.cancelled) {
      return { status: "cancelled", summary: "Run cancelled.", artifacts: [], openQuestions: [] };
    }
    if (input.timedOut) {
      return { status: "timed_out", summary: "Run exceeded its timeout.", artifacts: [], openQuestions: [] };
    }

    const resultEvent = [...input.events]
      .reverse()
      .find((e) => e.kind === "result")?.raw as ClaudeResultEvent | undefined;

    const artifacts = collectArtifacts(input.events);

    if (resultEvent) {
      // Verified behaviour: claude exits 0 even when the run failed, and
      // reports it only here via `is_error`. Trusting the exit code would
      // report an auth failure as a successful run.
      const failed = resultEvent.is_error === true;
      return {
        status: failed ? "failed" : "completed",
        summary: (resultEvent.result ?? "").slice(0, 4000),
        artifacts,
        usage: {
          inputTokens: resultEvent.usage?.input_tokens,
          outputTokens: resultEvent.usage?.output_tokens,
          costUsd: resultEvent.total_cost_usd,
        },
        openQuestions: [],
        terminalReason: resultEvent.terminal_reason,
      };
    }

    // No terminal event at all — the process died mid-stream.
    const lastText = [...input.events].reverse().find((e) => e.kind === "text")?.text ?? "";
    return {
      status: input.exitCode === 0 ? "completed" : "failed",
      summary: lastText.slice(0, 4000) || tail(input.stderrTail, 500),
      artifacts,
      openQuestions: [],
      terminalReason: "stream ended without a result event",
    };
  },
};

function collectArtifacts(events: OutcomeInput["events"]): Artifact[] {
  const out: Artifact[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    if (ev.kind !== "tool_call") continue;
    const raw = ev.raw as { message?: unknown } | undefined;
    for (const use of toolUsesFrom(raw?.message)) {
      if (!["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(use.name)) continue;
      const file = (use.input as { file_path?: string } | undefined)?.file_path;
      if (!file || seen.has(file)) continue;
      seen.add(file);
      out.push({ artifactId: `edit-${ev.seq}`, type: "file", ref: file, metadata: { tool: use.name } });
    }
  }
  return out;
}
