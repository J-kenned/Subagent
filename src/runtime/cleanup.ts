import { promises as fs } from "node:fs";
import { loadConfig } from "../config.js";
import { isTerminalStatus, type RunMeta } from "../types.js";
import { eventsPath, gzipInPlace, listRunIds, messagesPath, readMeta, removeRun, writeMeta } from "./storage.js";
import { registry } from "./registry.js";

export interface PruneOptions {
  compressAfterDays?: number;
  maxAgeDays?: number;
  keepLast?: number;
  dryRun?: boolean;
}

export interface PruneReport {
  compressed: string[];
  deleted: string[];
  skipped: number;
  dryRun: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Retention: full for N days, gzip in place to M, delete after, plus an LRU cap
 * on terminal runs. Non-terminal runs are never touched — an in-flight worker's
 * event log must not be pulled out from under it.
 */
export async function pruneRuns(opts: PruneOptions = {}): Promise<PruneReport> {
  const cfg = await loadConfig();
  const compressAfter = opts.compressAfterDays ?? cfg.retention.compressAfterDays;
  const maxAge = opts.maxAgeDays ?? cfg.retention.maxAgeDays;
  const keepLast = opts.keepLast ?? cfg.retention.maxRuns;
  const dryRun = opts.dryRun === true;

  const now = Date.now();
  const report: PruneReport = { compressed: [], deleted: [], skipped: 0, dryRun };

  const terminal: RunMeta[] = [];
  for (const runId of await listRunIds()) {
    const meta = registry.getMeta(runId) ?? (await readMeta(runId));
    if (!meta) continue;
    if (!isTerminalStatus(meta.status)) {
      report.skipped += 1;
      continue;
    }
    terminal.push(meta);
  }

  const ageOf = (meta: RunMeta): number => (now - (meta.endedAt ?? meta.createdAt)) / DAY_MS;

  for (const meta of terminal) {
    const age = ageOf(meta);
    if (maxAge > 0 && age > maxAge) {
      report.deleted.push(meta.runId);
      if (!dryRun) {
        await removeRun(meta.runId);
        registry.remove(meta.runId);
      }
      continue;
    }
    if (compressAfter > 0 && age > compressAfter && meta.retentionState !== "compressed") {
      report.compressed.push(meta.runId);
      if (!dryRun) {
        await gzipInPlace(eventsPath(meta.runId));
        await gzipInPlace(messagesPath(meta.runId));
        meta.retentionState = "compressed";
        meta.compressedAt = now;
        // Materialize the summary so meta stays self-describing once its
        // events are archived.
        meta.summary = meta.summary ?? meta.outcome?.summary;
        await writeMeta(meta);
      }
    }
  }

  // LRU cap on whatever survived the age rules.
  const survivors = terminal
    .filter((m) => !report.deleted.includes(m.runId))
    .sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt));
  if (keepLast > 0 && survivors.length > keepLast) {
    for (const meta of survivors.slice(keepLast)) {
      report.deleted.push(meta.runId);
      if (!dryRun) {
        await removeRun(meta.runId);
        registry.remove(meta.runId);
      }
    }
  }

  return report;
}

export async function ensureHome(home: string): Promise<void> {
  await fs.mkdir(home, { recursive: true });
}
