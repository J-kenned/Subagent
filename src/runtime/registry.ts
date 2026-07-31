import { isTerminalStatus, type ProviderId, type RunMeta } from "../types.js";
import type { ConcurrencySnapshot } from "../policy/index.js";
import { listRunIds, readMeta, writeMeta } from "./storage.js";
import type { Runner } from "./runner.js";

/**
 * Live run index.
 *
 * Metadata is the durable record on disk; `runners` only exist for runs this
 * process started. A run recovered from disk after a restart has no runner —
 * it can be read and pruned, but not cancelled or resumed in-process.
 */
class Registry {
  private readonly metas = new Map<string, RunMeta>();
  private readonly runners = new Map<string, Runner>();

  async load(): Promise<void> {
    for (const runId of await listRunIds()) {
      const meta = await readMeta(runId);
      if (!meta) continue;
      // A non-terminal run whose process died with the previous server is a
      // lie on disk. Mark it failed on load rather than leaving a zombie that
      // occupies a concurrency slot forever.
      if (!isTerminalStatus(meta.status) && !this.runners.has(runId)) {
        meta.status = "failed";
        meta.endedAt = meta.endedAt ?? Date.now();
        meta.summary = meta.summary ?? "Run was interrupted when the server stopped.";
        await writeMeta(meta);
      }
      this.metas.set(runId, meta);
    }
  }

  add(meta: RunMeta, runner?: Runner): void {
    this.metas.set(meta.runId, meta);
    if (runner) this.runners.set(meta.runId, runner);
  }

  getMeta(runId: string): RunMeta | undefined {
    return this.metas.get(runId);
  }

  getRunner(runId: string): Runner | undefined {
    return this.runners.get(runId);
  }

  list(): RunMeta[] {
    return [...this.metas.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async update(meta: RunMeta): Promise<void> {
    this.metas.set(meta.runId, meta);
    await writeMeta(meta);
  }

  remove(runId: string): void {
    this.metas.delete(runId);
    this.runners.delete(runId);
  }

  concurrency(): ConcurrencySnapshot {
    const byProvider: Record<string, number> = {};
    let total = 0;
    for (const meta of this.metas.values()) {
      if (isTerminalStatus(meta.status)) continue;
      total += 1;
      byProvider[meta.provider] = (byProvider[meta.provider] ?? 0) + 1;
    }
    return { total, byProvider };
  }

  activeFor(provider: ProviderId): number {
    return this.concurrency().byProvider[provider] ?? 0;
  }
}

export const registry = new Registry();
