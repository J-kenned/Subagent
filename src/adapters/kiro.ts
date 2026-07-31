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
import type { DraftEvent, Outcome, PermissionTier, RunSpec } from "../types.js";
import { probe, tail, withBridgedPrefix } from "./util.js";

/**
 * Kiro CLI (v2.15.x).
 *
 * The weakest provider on capability, and the reason the harness declares
 * capabilities instead of assuming them:
 *
 *  - `chat` has no structured output. `-f json` applies only to `--list-models`
 *    and `--list-sessions`, so a run yields plain stdout.
 *  - The session id is not exposed in headless mode
 *    (kirodotdev/Kiro#9066), so there is no handle to resume with. We declare
 *    `sessionHandle: "none"` and `followUp: false` rather than shipping a
 *    resume path that silently starts a fresh conversation.
 *
 * Both are one-line changes here when the vendor ships them.
 */

const capabilities: Capabilities = {
  stream: "text",
  sessionHandle: "none",
  resume: false,
  followUp: false,
  permissionTiers: ["read", "edit", "auto", "bypass"],
  extraDirs: false,
  systemPromptAppend: false,
  namedAgents: true,
  structuredOutput: false,
  spendCap: false,
  worktree: false,
  nativeContextFiles: [".kiro/steering"],
};

const TRUST_FLAGS: Record<PermissionTier, string[]> = {
  read: ["--trust-tools="],
  edit: ["--trust-tools=fs_read,fs_write"],
  auto: ["--trust-tools=fs_read,fs_write,execute_bash"],
  bypass: ["--trust-all-tools"],
};

/**
 * Buffers stdout and emits one text event plus a synthesized result at close.
 * Same envelope as the streaming providers, lower resolution — and
 * `list_providers` reports that difference so a caller is never surprised.
 */
class KiroParser implements StreamParser {
  private buf = "";

  push(chunk: string): DraftEvent[] {
    this.buf += chunk;
    return [];
  }

  flush(): DraftEvent[] {
    const text = this.buf.trim();
    this.buf = "";
    if (!text) return [];
    return [
      { kind: "text", text, raw: { stdout: text } },
      { kind: "result", text, raw: { synthesized: true, stdout: text } },
    ];
  }

  sessionHandle(): string | undefined {
    return undefined;
  }
}

export const kiroAdapter: AgentAdapter = {
  id: "kiro",
  displayName: "Kiro CLI",
  transport: "cli",
  capabilities,
  defaultBin: "kiro-cli",
  envAllowlist: [
    "PATH",
    "HOME",
    "SHELL",
    "LANG",
    "TERM",
    "TMPDIR",
    "KIRO_API_KEY",
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
        remedy: "Install Kiro CLI — https://kiro.dev/docs/cli",
      };
    }
    if (process.env["KIRO_API_KEY"]) {
      return { installed: true, authenticated: true, method: "KIRO_API_KEY" };
    }
    // `--list-models` is the cheapest call that requires working credentials.
    const models = await probe(env.bin, ["chat", "--list-models", "-f", "json"], env.env, 20_000);
    if (models.ok) {
      return { installed: true, authenticated: true, method: "login" };
    }
    return {
      installed: true,
      authenticated: false,
      reason: tail(`${models.stdout}${models.stderr}`, 200) || "not authenticated",
      remedy: "Run `kiro-cli login` (or set KIRO_API_KEY)",
    };
  },

  plan(spec: RunSpec, ctx: PlanContext, env: AdapterEnv): Invocation {
    const argv = ["chat", "--no-interactive", ...TRUST_FLAGS[spec.permission]];
    if (spec.model) argv.push("--model", spec.model);
    if (spec.agent) argv.push("--agent", spec.agent);
    argv.push(withBridgedPrefix(spec.prompt, ctx.bridgedContext));

    // cwd is the only context channel Kiro has — it discovers .kiro/steering
    // relative to the process working directory.
    return { transport: "cli", bin: env.bin, argv, cwd: spec.cwd, env: env.env };
  },

  createParser(): StreamParser {
    return new KiroParser();
  },

  deriveOutcome(input: OutcomeInput): Outcome {
    if (input.cancelled) {
      return { status: "cancelled", summary: "Run cancelled.", artifacts: [], openQuestions: [] };
    }
    if (input.timedOut) {
      return { status: "timed_out", summary: "Run exceeded its timeout.", artifacts: [], openQuestions: [] };
    }
    const text = [...input.events].reverse().find((e) => e.kind === "result")?.text ?? "";
    const failed = input.exitCode !== null && input.exitCode !== 0;
    return {
      status: failed ? "failed" : "completed",
      summary: (text || tail(input.stderrTail, 500)).slice(0, 4000),
      // Text-only stream: no tool telemetry to mine, so artifacts stay empty
      // rather than being guessed at from prose.
      artifacts: [],
      openQuestions: [],
      ...(failed ? { terminalReason: `exit ${input.exitCode}` } : {}),
    };
  },
};
