import type {
  DraftEvent,
  PermissionTier,
  ProviderId,
  Outcome,
  RunSpec,
} from "../types.js";

/**
 * What a provider can actually do. Declared, not assumed — the harness reads
 * these to decide how to drive a provider and degrades honestly when something
 * is missing, rather than flattening every vendor to the weakest one.
 */
export interface Capabilities {
  /** Structured stream, or plain stdout we have to buffer. */
  stream: "ndjson" | "text";
  /**
   * How we get a resume handle.
   *  - preassigned: we generate it and pass it in (claude --session-id)
   *  - scraped:     we read it out of the stream
   *  - none:        the provider does not expose one
   */
  sessionHandle: "preassigned" | "scraped" | "none";
  resume: boolean;
  followUp: boolean;
  permissionTiers: PermissionTier[];
  /** Can grant read access outside cwd. */
  extraDirs: boolean;
  /** Has an out-of-band system prompt channel — the preferred bridging vector. */
  systemPromptAppend: boolean;
  namedAgents: boolean;
  structuredOutput: boolean;
  spendCap: boolean;
  worktree: boolean;
  /** Context files this provider discovers unaided, as glob-ish suffixes. */
  nativeContextFiles: string[];
}

export interface AuthState {
  installed: boolean;
  authenticated: boolean;
  /** Free-text account identity when the provider reports one. */
  account?: string;
  method?: string;
  reason?: string;
  /** Exact command the developer should run to fix it. */
  remedy?: string;
}

export interface HttpRequest {
  url: string;
  method: "GET" | "POST" | "DELETE";
  headers: Record<string, string>;
  body?: unknown;
}

export interface PollSpec {
  statusUrl: (handle: string) => HttpRequest;
  intervalMs: number;
  maxIntervalMs: number;
}

export type Invocation =
  | {
      transport: "cli";
      bin: string;
      argv: string[];
      cwd: string;
      env: Record<string, string>;
      stdin?: string;
    }
  | {
      transport: "http";
      request: HttpRequest;
      poll: PollSpec;
    };

/** Context the harness resolved for this run, handed to the adapter to apply. */
export interface PlanContext {
  kind: "spawn" | "resume";
  /**
   * Context the provider will NOT find on its own. Adapters apply this using
   * whatever vector they declare — system prompt if they have one, otherwise a
   * prompt prefix.
   */
  bridgedContext?: string;
  /** Pre-generated handle, only for `sessionHandle: "preassigned"` providers. */
  preassignedHandle?: string;
}

export interface StreamParser {
  /** Feed a stdout chunk; return whatever complete events it yielded. */
  push(chunk: string): DraftEvent[];
  /** Flush any buffered remainder at process close. */
  flush(): DraftEvent[];
  /** Handle scraped from the stream so far, if any. */
  sessionHandle(): string | undefined;
}

export interface OutcomeInput {
  events: Array<{ seq: number; kind: string; text?: string; raw: unknown }>;
  exitCode: number | null;
  stderrTail: string;
  cancelled: boolean;
  timedOut: boolean;
}

export interface AdapterEnv {
  /** Resolved binary path or name for this provider. */
  bin: string;
  /** Environment allowlist already applied by the caller. */
  env: Record<string, string>;
}

export interface AgentAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly transport: "cli" | "http";
  readonly capabilities: Capabilities;
  /** Default binary name for CLI providers; ignored for http. */
  readonly defaultBin: string;
  /** Environment variables this provider legitimately needs. */
  readonly envAllowlist: string[];

  /** Never throws — returns a diagnosis the caller can surface verbatim. */
  preflight(env: AdapterEnv): Promise<AuthState>;

  plan(spec: RunSpec, ctx: PlanContext, env: AdapterEnv): Invocation;

  createParser(): StreamParser;

  deriveOutcome(input: OutcomeInput): Outcome;
}
