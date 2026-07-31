import { randomUUID } from "node:crypto";

/**
 * Identifier for this server process, stamped onto every run it spawns.
 *
 * Claude Code does not hand a child MCP server its session id, so this rarely
 * matches what the completion hook sees. The hook treats a mismatch as
 * `[unlinked]` and reports it anyway: over-reporting is recoverable, a silently
 * lost result is not.
 */
const id = process.env["SUBAGENT_SESSION_ID"] ?? randomUUID();

export function harnessSessionId(): string {
  return id;
}
