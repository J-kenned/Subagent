import { promises as fs, createReadStream, createWriteStream } from "node:fs";
import { createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import type { NormalizedEvent, RunMeta, StoredMessage } from "../types.js";
import { harnessHome } from "../config.js";

export function runsDir(): string {
  return path.join(harnessHome(), "runs");
}

export function runDir(runId: string): string {
  return path.join(runsDir(), runId);
}

export function metaPath(runId: string): string {
  return path.join(runDir(runId), "meta.json");
}

export function eventsPath(runId: string): string {
  return path.join(runDir(runId), "events.ndjson");
}

export function messagesPath(runId: string): string {
  return path.join(runDir(runId), "messages.ndjson");
}

export function bridgedContextPath(runId: string): string {
  return path.join(runDir(runId), "bridged-context.md");
}

export function hookStateDir(): string {
  return path.join(harnessHome(), "hook-state");
}

export async function ensureRunDir(runId: string): Promise<void> {
  await fs.mkdir(runDir(runId), { recursive: true });
}

export async function writeMeta(meta: RunMeta): Promise<void> {
  await ensureRunDir(meta.runId);
  const file = metaPath(meta.runId);
  const tmp = `${file}.tmp`;
  // Write-then-rename: the hooks read these files concurrently and must never
  // observe a half-written record.
  await fs.writeFile(tmp, JSON.stringify(meta, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export async function readMeta(runId: string): Promise<RunMeta | undefined> {
  try {
    return JSON.parse(await fs.readFile(metaPath(runId), "utf8")) as RunMeta;
  } catch {
    return undefined;
  }
}

export async function listRunIds(): Promise<string[]> {
  try {
    const entries = await fs.readdir(runsDir(), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function appendEvents(runId: string, events: NormalizedEvent[]): Promise<void> {
  if (!events.length) return;
  await fs.appendFile(eventsPath(runId), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

export async function appendMessage(message: StoredMessage): Promise<void> {
  await ensureRunDir(message.runId);
  await fs.appendFile(messagesPath(message.runId), JSON.stringify(message) + "\n", "utf8");
}

export async function writeBridgedContext(runId: string, payload: string): Promise<void> {
  await ensureRunDir(runId);
  await fs.writeFile(bridgedContextPath(runId), payload, "utf8");
}

async function readMaybeGzipped(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
  }
  try {
    const chunks: Buffer[] = [];
    const gunzip = createGunzip();
    gunzip.on("data", (c: Buffer) => chunks.push(c));
    await pipeline(createReadStream(`${file}.gz`), gunzip);
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return undefined;
  }
}

/** Read events, transparently handling the gzipped form left by retention. */
export async function readEvents(runId: string, sinceSeq = 0, limit = 1000): Promise<NormalizedEvent[]> {
  const raw = await readMaybeGzipped(eventsPath(runId));
  if (!raw) return [];
  const out: NormalizedEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const ev = JSON.parse(trimmed) as NormalizedEvent;
      if (ev.seq > sinceSeq) out.push(ev);
    } catch {
      continue;
    }
    if (out.length >= limit) break;
  }
  return out;
}

export async function gzipInPlace(file: string): Promise<boolean> {
  try {
    await fs.access(file);
  } catch {
    return false;
  }
  await pipeline(createReadStream(file), createGzip(), createWriteStream(`${file}.gz`));
  await fs.rm(file, { force: true });
  return true;
}

export async function removeRun(runId: string): Promise<void> {
  await fs.rm(runDir(runId), { recursive: true, force: true });
}
