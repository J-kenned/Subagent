import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

type Level = "debug" | "info" | "warning" | "error";

let bound: Server | undefined;

export function bindServer(server: Server): void {
  bound = server;
}

/**
 * Best-effort MCP log notification. Notification failures are swallowed: a
 * client that isn't listening must never take down a run.
 */
export function notifyMessage(level: Level, logger: string, data: unknown): void {
  if (!bound) return;
  void bound.notification({ method: "notifications/message", params: { level, logger, data } }).catch(() => {});
}

export function notifyResourceUpdated(uri: string): void {
  if (!bound) return;
  void bound.notification({ method: "notifications/resources/updated", params: { uri } }).catch(() => {});
}
