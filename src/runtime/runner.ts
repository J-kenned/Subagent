import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { AgentAdapter, PlanContext } from "../adapters/types.js";
import type { DraftEvent, NormalizedEvent, RunMeta, RunSpec, TurnRecord } from "../types.js";
import { appendEvents, readEvents, writeMeta } from "./storage.js";
import { notifyMessage, notifyResourceUpdated } from "./notifier.js";
import { tail } from "../adapters/util.js";

type Child = ChildProcessByStdio<null, Readable, Readable>;

export interface RunnerHooks {
  /** Called once the run reaches a terminal state. */
  onTerminal?: (meta: RunMeta) => void;
}

/**
 * Owns one run's child process across turns.
 *
 * A run is a conversation, not a one-shot: `startTurn` can be called again on a
 * completed run to resume it, which is what makes `send_message` work.
 */
export class Runner {
  private child?: Child;
  private turnPromise?: Promise<void>;
  private cancelled = false;
  private timedOut = false;

  constructor(
    readonly meta: RunMeta,
    private readonly adapter: AgentAdapter,
    private readonly hooks: RunnerHooks = {},
  ) {}

  get runId(): string {
    return this.meta.runId;
  }

  isBusy(): boolean {
    return !!this.child && this.child.exitCode === null;
  }

  /** Resolves when the in-flight turn settles. Used by cancel and by tests. */
  async waitIdle(): Promise<void> {
    await this.turnPromise?.catch(() => {});
  }

  async startTurn(args: {
    spec: RunSpec;
    message: string;
    kind: "spawn" | "resume";
    bridgedContext?: string;
    preassignedHandle?: string;
    bin: string;
    env: Record<string, string>;
  }): Promise<TurnRecord> {
    if (this.isBusy()) {
      throw new Error(`run ${this.runId} is busy with turn ${this.meta.currentTurn?.turnId}`);
    }

    const turn: TurnRecord = {
      turnId: randomUUID(),
      kind: args.kind,
      message: args.message,
      startedAt: Date.now(),
    };
    this.cancelled = false;
    this.timedOut = false;
    this.meta.currentTurn = turn;
    this.meta.turns.push(turn);
    this.meta.status = "running";
    await writeMeta(this.meta);

    const ctx: PlanContext = {
      kind: args.kind,
      ...(args.bridgedContext ? { bridgedContext: args.bridgedContext } : {}),
      ...(args.preassignedHandle ? { preassignedHandle: args.preassignedHandle } : {}),
    };
    const invocation = this.adapter.plan({ ...args.spec, prompt: args.message }, ctx, {
      bin: args.bin,
      env: args.env,
    });

    if (invocation.transport !== "cli") {
      throw new Error(`adapter ${this.adapter.id} is not a CLI provider`);
    }

    const child = spawn(invocation.bin, invocation.argv, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ["ignore", "pipe", "pipe"],
    }) as Child;
    this.child = child;

    this.turnPromise = this.consume(child, turn).finally(() => {
      this.child = undefined;
    });

    return turn;
  }

  private async consume(child: Child, turn: TurnRecord): Promise<void> {
    const parser = this.adapter.createParser();
    let stderrBuf = "";
    let watchdog: NodeJS.Timeout | undefined;

    if (this.meta.timeoutMs && this.meta.timeoutMs > 0) {
      watchdog = setTimeout(() => {
        this.timedOut = true;
        notifyMessage("warning", this.runId, `turn ${turn.turnId} exceeded ${this.meta.timeoutMs}ms`);
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }, this.meta.timeoutMs);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    // Serialize persistence so appends can't interleave and corrupt the NDJSON.
    let writeChain: Promise<void> = Promise.resolve();
    const persist = (drafts: DraftEvent[]): void => {
      if (!drafts.length) return;
      writeChain = writeChain.then(() => this.persist(turn.turnId, drafts)).catch(() => {});
    };

    child.stdout.on("data", (chunk: string) => persist(parser.push(chunk)));
    child.stderr.on("data", (chunk: string) => {
      stderrBuf = tail(stderrBuf + chunk, 8192);
    });

    await new Promise<void>((resolve) => {
      const finish = async (exitCode: number | null): Promise<void> => {
        if (watchdog) clearTimeout(watchdog);
        persist(parser.flush());
        await writeChain;
        const handle = parser.sessionHandle();
        if (handle && !this.meta.sessionHandle) this.meta.sessionHandle = handle;
        await this.finalize(turn, exitCode, stderrBuf);
        resolve();
      };

      child.on("close", (code) => void finish(code));
      child.on("error", (err: Error) => {
        stderrBuf = tail(`${stderrBuf}\n${err.message}`, 8192);
        void finish(null);
      });
    });
  }

  private async persist(turnId: string, drafts: DraftEvent[]): Promise<void> {
    const events: NormalizedEvent[] = [];
    for (const draft of drafts) {
      this.meta.lastSeq += 1;
      this.meta.lastEventAt = Date.now();
      events.push({ ...draft, seq: this.meta.lastSeq, ts: this.meta.lastEventAt, runId: this.runId, turnId });
      if (draft.sessionHandle && !this.meta.sessionHandle) {
        this.meta.sessionHandle = draft.sessionHandle;
      }
    }
    await appendEvents(this.runId, events);
    notifyResourceUpdated(`subagent://${this.runId}/events`);
  }

  private async finalize(turn: TurnRecord, exitCode: number | null, stderrTail: string): Promise<void> {
    turn.endedAt = Date.now();
    turn.exitCode = exitCode;
    this.meta.currentTurn = undefined;

    const events = await readEvents(this.runId, 0, 100_000);
    const outcome = this.adapter.deriveOutcome({
      events: events.map((e) => ({ seq: e.seq, kind: e.kind, ...(e.text ? { text: e.text } : {}), raw: e.raw })),
      exitCode,
      stderrTail,
      cancelled: this.cancelled,
      timedOut: this.timedOut,
    });

    this.meta.status = outcome.status;
    this.meta.outcome = outcome;
    this.meta.summary = outcome.summary;
    this.meta.endedAt = turn.endedAt;
    await writeMeta(this.meta);
    notifyResourceUpdated(`subagent://${this.runId}/status`);

    const level = outcome.status === "completed" ? "info" : outcome.status === "cancelled" ? "warning" : "error";
    const oneLine = outcome.summary.replace(/\s+/g, " ").trim().slice(0, 240);
    notifyMessage(
      level,
      this.runId,
      `SUBAGENT ${this.runId} [${this.meta.provider}] → ${outcome.status}${oneLine ? ` — ${oneLine}` : ""}`,
    );

    this.hooks.onTerminal?.(this.meta);
  }

  async cancel(): Promise<void> {
    if (!this.child) return;
    this.cancelled = true;
    try {
      this.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    await this.waitIdle();
  }
}
