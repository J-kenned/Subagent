import type { AgentAdapter, AdapterEnv } from "./types.js";
import type { ProviderId } from "../types.js";
import type { Config } from "../config.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import { kiroAdapter } from "./kiro.js";

const ADAPTERS: readonly AgentAdapter[] = [claudeAdapter, codexAdapter, cursorAdapter, kiroAdapter];

const BY_ID = new Map<ProviderId, AgentAdapter>(ADAPTERS.map((a) => [a.id, a]));

export function listAdapters(): readonly AgentAdapter[] {
  return ADAPTERS;
}

export function getAdapter(id: string): AgentAdapter {
  const adapter = BY_ID.get(id as ProviderId);
  if (!adapter) {
    const known = ADAPTERS.map((a) => a.id).join(", ");
    throw new Error(`unknown provider "${id}". Known providers: ${known}`);
  }
  return adapter;
}

export function isKnownProvider(id: string): id is ProviderId {
  return BY_ID.has(id as ProviderId);
}

/**
 * Build the child environment for a provider.
 *
 * Deliberately not `{...process.env}`: a dispatched agent has no reason to
 * receive the parent's unrelated API keys, and the blast radius of a confused
 * or compromised worker should not include the developer's whole secret
 * environment.
 */
export function adapterEnv(adapter: AgentAdapter, cfg: Config): AdapterEnv {
  const env: Record<string, string> = {};
  for (const key of adapter.envAllowlist) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const bin = cfg.providers[adapter.id]?.bin ?? adapter.defaultBin;
  return { bin, env };
}
