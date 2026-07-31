import { spawn } from "node:child_process";
import type { DraftEvent } from "../types.js";

export interface ProbeResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the binary itself could not be found or executed. */
  missing: boolean;
}

/**
 * Run a short-lived probe command (version / auth status). Never rejects —
 * preflight is diagnostic, so a failure is data, not an exception.
 */
export function probe(
  bin: string,
  argv: string[],
  env: Record<string, string>,
  timeoutMs = 10_000,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: ProbeResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    let child;
    try {
      child = spawn(bin, argv, { stdio: ["ignore", "pipe", "pipe"], env });
    } catch (err) {
      done({ ok: false, code: null, stdout: "", stderr: (err as Error).message, missing: true });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      done({ ok: false, code: null, stdout, stderr: `${stderr}\n[probe timed out]`, missing: false });
    }, timeoutMs);

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      done({
        ok: false,
        code: null,
        stdout,
        stderr: err.message,
        missing: err.code === "ENOENT",
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, code, stdout, stderr, missing: false });
    });
  });
}

/**
 * Incremental newline-delimited JSON splitter. Holds a partial trailing line
 * across chunks — provider streams arrive on arbitrary boundaries.
 */
export class NdjsonSplitter {
  private rest = "";

  push(chunk: string): unknown[] {
    const combined = this.rest + chunk;
    const lines = combined.split("\n");
    this.rest = lines.pop() ?? "";
    return this.parseAll(lines);
  }

  flush(): unknown[] {
    if (!this.rest.trim()) {
      this.rest = "";
      return [];
    }
    const line = this.rest;
    this.rest = "";
    return this.parseAll([line]);
  }

  private parseAll(lines: string[]): unknown[] {
    const out: unknown[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        // Keep unparseable output rather than dropping it — a vendor writing
        // a stray warning to stdout should not silently vanish from the record.
        out.push({ __unparsed: trimmed });
      }
    }
    return out;
  }
}

/** Prompt-prefix bridging vector, used by providers with no system-prompt channel. */
export function withBridgedPrefix(prompt: string, bridged?: string): string {
  if (!bridged) return prompt;
  return `${bridged}\n\n---\n\n${prompt}`;
}

export function errorEvent(message: string, recoverable = false): DraftEvent {
  return { kind: "error", error: { message, recoverable }, raw: { message } };
}

/** Bounded tail, so a runaway stderr can't blow up a stored record. */
export function tail(s: string, max = 4000): string {
  return s.length <= max ? s : s.slice(-max);
}
