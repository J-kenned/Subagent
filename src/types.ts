/**
 * Provider-neutral domain types.
 *
 * Nothing in this file may mention a vendor's CLI grammar. Vendor specifics
 * live behind `AgentAdapter` (see adapters/types.ts) — that separation is what
 * lets a fifth provider be one new file rather than a refactor.
 */

export type ProviderId =
  | "claude"
  | "codex"
  | "cursor"
  | "kiro"
  | "cursor-cloud"
  | "anthropic-managed";

export type RunTarget = "local" | "cloud";

/**
 * Ordered permission ladder, normalized across vendors. Rank matters: it is
 * what makes a per-provider ceiling enforceable.
 */
export const PERMISSION_TIERS = ["read", "edit", "auto", "bypass"] as const;
export type PermissionTier = (typeof PERMISSION_TIERS)[number];

export function permissionRank(tier: PermissionTier): number {
  return PERMISSION_TIERS.indexOf(tier);
}

export type RunStatus =
  | "created"
  | "running"
  | "waiting_on_parent"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventKind =
  | "lifecycle"
  | "text"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "usage"
  | "error"
  | "result";

export interface EventUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
}

/**
 * The single envelope every provider's output collapses into. `raw` is never
 * dropped — normalization is additive, so a vendor payload we don't model yet
 * still lands on disk and is still readable via `get_events`.
 */
export interface NormalizedEvent {
  seq: number;
  ts: number;
  runId: string;
  turnId: string;
  kind: EventKind;
  text?: string;
  tool?: {
    name: string;
    input?: unknown;
    output?: unknown;
    ok?: boolean;
  };
  usage?: EventUsage;
  error?: { message: string; recoverable: boolean };
  /** Provider-native session handle, when this event is the one that reveals it. */
  sessionHandle?: string;
  raw: unknown;
}

/** An event as produced by a parser, before the runtime stamps seq/ts/ids. */
export type DraftEvent = Omit<NormalizedEvent, "seq" | "ts" | "runId" | "turnId">;

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface Artifact {
  artifactId: string;
  type: "file" | "log" | "diff" | "pr" | "branch" | "other";
  ref: string;
  metadata?: Record<string, unknown>;
}

export interface Outcome {
  status: RunStatus;
  summary: string;
  artifacts: Artifact[];
  usage?: EventUsage;
  openQuestions: string[];
  /** Why the run ended, in the provider's own words where available. */
  terminalReason?: string;
}

export interface TurnRecord {
  turnId: string;
  kind: "spawn" | "resume";
  message: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
}

/** What was actually injected into a worker, and what it found on its own. */
export interface InheritedContext {
  native: string[];
  bridged: Array<{ path: string; bytes: number; via: "system-prompt" | "prompt-prefix" }>;
  truncated: boolean;
}

export type RetentionState = "full" | "compressed";

export interface RunMeta {
  runId: string;
  label?: string;
  provider: ProviderId;
  target: RunTarget;
  status: RunStatus;

  model?: string;
  permission: PermissionTier;
  agent?: string;

  workspace?: string;
  cwd: string;

  /** Provider-native resume handle (session id / chat id). */
  sessionHandle?: string;

  createdAt: number;
  startedAt: number;
  endedAt?: number;
  lastEventAt?: number;
  lastSeq: number;

  currentTurn?: TurnRecord;
  turns: TurnRecord[];

  initialPrompt: string;
  timeoutMs?: number;
  maxBudgetUsd?: number;

  inheritedContext?: InheritedContext;
  outcome?: Outcome;

  retentionState?: RetentionState;
  compressedAt?: number;
  /** Materialized at compression time so meta stays self-describing. */
  summary?: string;

  spawnedBySession?: string;
}

export interface StoredMessage {
  messageId: string;
  runId: string;
  turnId: string;
  direction: "parent_to_worker" | "worker_to_parent";
  content: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Spawn request
// ---------------------------------------------------------------------------

export interface RunSpec {
  runId: string;
  provider: ProviderId;
  target: RunTarget;
  prompt: string;
  cwd: string;
  workspace?: string;
  model?: string;
  permission: PermissionTier;
  agent?: string;
  timeoutMs?: number;
  maxBudgetUsd?: number;
  extraDirs: string[];
  /** Repo reference for cloud targets, e.g. "github.com/owner/repo". */
  repo?: string;
  ref?: string;
  sessionHandle?: string;
}

export class PolicyError extends Error {
  override readonly name = "PolicyError";
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export class CapabilityError extends Error {
  override readonly name = "CapabilityError";
  constructor(
    readonly provider: ProviderId,
    readonly capability: string,
    message: string,
  ) {
    super(message);
  }
}
