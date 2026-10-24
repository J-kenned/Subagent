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
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { NdjsonSplitter, probe, tail, withBridgedPrefix } from "./util.js";

/**
 * OpenAI Codex CLI (`codex exec`), validated against codex-cli 0.146.0.
 *
 * The binary is not always on PATH: on macOS the Codex CLI ships bundled inside
 * the ChatGPT desktop app rather than as an npm/global install, so a plain
 * `codex` lookup fails even when Codex is present. `resolveCodexBin` prefers a
 * PATH `codex`, then falls back to the known bundle location; a configured
 * `providers.codex.bin` still overrides both.
 *
 * The parser stays deliberately tolerant of shape drift: it recognises several
 * known event envelopes and degrades to `lifecycle` rather than throwing on
 * anything it does not know.
 */

/** Where the ChatGPT desktop app bundles the Codex CLI on macOS. */
const CHATGPT_BUNDLED_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";

function onPath(bin: string): boolean {
  const dirs = (process.env["PATH"] ?? "").split(delimiter);
  return dirs.some((d) => d !== "" && existsSync(join(d, bin)));
}

/** PATH `codex` wins for portability; otherwise fall back to the macOS bundle. */
function resolveCodexBin(): string {
  if (onPath("codex")) return "codex";
  if (existsSync(CHATGPT_BUNDLED_CODEX)) return CHATGPT_BUNDLED_CODEX;
  return "codex";
}

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
  worktree: false,
  nativeContextFiles: ["AGENTS.md"],
};

const SANDBOX_FLAG: Record<PermissionTier, string> = {
  read: "read-only",
  edit: "workspace-write",
  auto: "workspace-write",
  bypass: "danger-full-access",
};

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

class CodexParser implements StreamParser {
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
      const ev = asRecord(raw);
      if (!ev) continue;

      // Codex has shipped both a flat `{type}` envelope and a nested `{msg:{type}}`
      // one. Accept either rather than betting on a version.
      const inner = asRecord(ev["msg"]) ?? asRecord(ev["item"]) ?? ev;
      const type = String(ev["type"] ?? inner["type"] ?? "");

      const sid = ev["session_id"] ?? ev["conversation_id"] ?? inner["session_id"];
      if (typeof sid === "string" && !this.handle) this.handle = sid;

      if (/session|thread\.started|configured/i.test(type)) {
        out.push({
          kind: "lifecycle",
          text: type,
          ...(typeof sid === "string" ? { sessionHandle: sid } : {}),
          raw,
        });
        continue;
      }

      if (/agent_reasoning|reasoning/i.test(type)) {
        out.push({ kind: "reasoning", text: textOf(inner), raw });
        continue;
      }

      if (/agent_message|assistant|item\.completed/i.test(type)) {
        const text = textOf(inner);
        if (text) {
          out.push({ kind: "text", text, raw });
          continue;
        }
      }

      if (/command|exec|patch|tool/i.test(type)) {
        const done = /end|complete|output|result/i.test(type);
        const name = String(inner["command"] ?? inner["name"] ?? "tool");
        out.push(
          done
            ? { kind: "tool_result", tool: { name, output: inner["output"] ?? inner["stdout"], ok: inner["exit_code"] === 0 }, raw }
            : { kind: "tool_call", tool: { name, input: inner["command"] ?? inner["args"] }, raw },
        );
        continue;
      }

      if (/task_complete|turn\.completed|shutdown|result/i.test(type)) {
        out.push({ kind: "result", text: textOf(inner), raw });
        continue;
      }

      if (/error/i.test(type)) {
        out.push({
          kind: "error",
          error: { message: textOf(inner) || type, recoverable: false },
          raw,
        });
        continue;
      }

      out.push({ kind: "lifecycle", text: type || undefined, raw });
    }
    return out;
  }
}

function textOf(rec: Record<string, unknown>): string {
  for (const key of ["message", "text", "last_agent_message", "content", "delta"]) {
    const v = rec[key];
    if (typeof v === "string" && v) return v;
    if (Array.isArray(v)) {
      const joined = v
        .map((c) => (c && typeof c === "object" ? String((c as { text?: unknown }).text ?? "") : ""))
        .join("");
      if (joined) return joined;
    }
  }
  return "";
}

export const codexAdapter: AgentAdapter = {
  id: "codex",
  displayName: "OpenAI Codex",
  transport: "cli",
  capabilities,
  defaultBin: resolveCodexBin(),
  envAllowlist: ["PATH", "HOME", "SHELL", "LANG", "TERM", "TMPDIR", "OPENAI_API_KEY", "CODEX_HOME"],

  async preflight(env: AdapterEnv): Promise<AuthState> {
    const version = await probe(env.bin, ["--version"], env.env);
    if (version.missing) {
      return {
        installed: false,
        authenticated: false,
        reason: `${env.bin} not found`,
        remedy:
          "Install the Codex CLI (ships with the ChatGPT desktop app, or `brew install --cask codex`) " +
          `and set providers.codex.bin to its path, e.g. ${CHATGPT_BUNDLED_CODEX}`,
      };
    }
    if (process.env["OPENAI_API_KEY"]) {
      return { installed: true, authenticated: true, method: "OPENAI_API_KEY" };
    }
    const auth = await probe(env.bin, ["login", "status"], env.env, 15_000);
    const blob = `${auth.stdout}${auth.stderr}`;
    if (auth.ok && !/not logged in|no credentials|logged out/i.test(blob)) {
      return { installed: true, authenticated: true, method: "oauth" };
    }
    return {
      installed: true,
      authenticated: false,
      reason: tail(blob, 200) || "not logged in",
      remedy: "Run `codex login` (or set OPENAI_API_KEY)",
    };
  },

  plan(spec: RunSpec, ctx: PlanContext, env: AdapterEnv): Invocation {
    // `codex exec` refuses to run outside a Git repo / trusted directory unless
    // told otherwise. This server already gates which workspaces may be entered
    // (deny-by-default roots), so codex's own repo check is redundant friction —
    // without this, dispatching into any non-git workspace fails immediately.
    const argv = ["exec", "--json", "--skip-git-repo-check", "--sandbox", SANDBOX_FLAG[spec.permission], "--cd", spec.cwd];
    if (spec.model) argv.push("--model", spec.model);

    if (ctx.kind === "resume") {
      const handle = spec.sessionHandle;
      argv.splice(1, 0, "resume", ...(handle ? [handle] : ["--last"]));
    }

    // No system-prompt channel — bridged context rides in front of the prompt.
    argv.push(withBridgedPrefix(spec.prompt, ctx.bridgedContext));

    return { transport: "cli", bin: env.bin, argv, cwd: spec.cwd, env: env.env };
  },

  createParser(): StreamParser {
    return new CodexParser();
  },

  deriveOutcome(input: OutcomeInput): Outcome {
    if (input.cancelled) {
      return { status: "cancelled", summary: "Run cancelled.", artifacts: [], openQuestions: [] };
    }
    if (input.timedOut) {
      return { status: "timed_out", summary: "Run exceeded its timeout.", artifacts: [], openQuestions: [] };
    }

    const errored = input.events.some((e) => e.kind === "error");
    const lastResult = [...input.events].reverse().find((e) => e.kind === "result")?.text;
    const lastText = [...input.events].reverse().find((e) => e.kind === "text")?.text ?? "";

    const failed = errored || (input.exitCode !== null && input.exitCode !== 0);
    return {
      status: failed ? "failed" : "completed",
      summary: (lastResult || lastText || tail(input.stderrTail, 500)).slice(0, 4000),
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
    const raw = asRecord(ev.raw);
    const inner = asRecord(raw?.["msg"]) ?? asRecord(raw?.["item"]) ?? raw;
    const cmd = inner?.["command"];
    if (typeof cmd === "string") {
      out.push({ artifactId: `shell-${ev.seq}`, type: "log", ref: cmd, metadata: { exitCode: inner?.["exit_code"] } });
    }
  }
  return out;
}
