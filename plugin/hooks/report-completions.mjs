#!/usr/bin/env node
/**
 * Completion reporter, shared by the UserPromptSubmit and Stop hooks.
 *
 * Scans the run store for terminal transitions and prints one line each to
 * stdout, which Claude Code injects into the turn context. That is what lets a
 * finished worker surface without the developer polling for it.
 *
 * Session scoping: Claude Code does not hand a child MCP server its session id,
 * so runs stamped with the server's own id rarely match what this hook sees.
 * Mismatches are tagged [unlinked] and reported anyway — over-reporting is
 * recoverable, a silently lost result is not.
 *
 * This hook must never fail loudly: a broken reporter should not wedge the
 * developer's prompt path.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = process.env["SUBAGENT_HOME"] ?? path.join(os.homedir(), ".subagent");
const RUNS_DIR = path.join(HOME, "runs");
const STATE_DIR = path.join(HOME, "hook-state");
const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);
const ICON = { completed: "✓", failed: "✗", cancelled: "⊘", timed_out: "⏱" };

async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function loadRuns() {
  let entries;
  try {
    entries = fs.readdirSync(RUNS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => readJson(path.join(RUNS_DIR, e.name, "meta.json"), null))
    .filter(Boolean);
}

function describe(meta, unlinked) {
  const icon = ICON[meta.status] ?? "•";
  const where = meta.workspace ? `/${meta.workspace}` : "";
  const label = meta.label ? ` "${meta.label}"` : "";
  const seconds =
    meta.endedAt && meta.startedAt ? ` (${Math.round((meta.endedAt - meta.startedAt) / 1000)}s)` : "";
  const summary = String(meta.summary ?? meta.outcome?.summary ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  const files = (meta.outcome?.artifacts ?? [])
    .filter((a) => a.type === "file")
    .map((a) => a.ref);
  const filesLine = files.length ? `\n    files: ${files.slice(0, 8).join(", ")}${files.length > 8 ? ` (+${files.length - 8})` : ""}` : "";

  return [
    `  ${icon} ${meta.provider}${where}${label} → ${meta.status}${seconds}${unlinked ? " [unlinked]" : ""}`,
    summary ? `\n    ${summary}` : "",
    filesLine,
    `\n    run_id: ${meta.runId}`,
  ].join("");
}

async function main() {
  const stdin = await readStdin();
  let sessionId = null;
  try {
    const parsed = stdin ? JSON.parse(stdin) : {};
    sessionId = parsed.session_id ?? parsed.sessionId ?? parsed.session?.id ?? null;
  } catch {
    /* no session id available; fall through to global state */
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const stateFile = path.join(STATE_DIR, `${sessionId ?? "global"}.json`);
  const state = readJson(stateFile, { reported: {} });
  if (!state.reported) state.reported = {};

  const lines = [];
  for (const meta of loadRuns()) {
    if (!TERMINAL.has(meta.status)) continue;
    if (state.reported[meta.runId] === meta.status) continue;
    const unlinked = Boolean(sessionId && meta.spawnedBySession && meta.spawnedBySession !== sessionId);
    lines.push(describe(meta, unlinked));
    state.reported[meta.runId] = meta.status;
  }

  if (lines.length) {
    process.stdout.write(
      `[subagent] ${lines.length} agent${lines.length === 1 ? "" : "s"} finished since your last turn:\n${lines.join("\n")}\n` +
        `Report these to the user before continuing. Use get_result <run_id> for full detail.\n`,
    );
  }

  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
}

main().catch((err) => {
  process.stderr.write(`[subagent hook] ${err?.message ?? String(err)}\n`);
  process.exit(0);
});
