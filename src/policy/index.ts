import type { Config } from "../config.js";
import type { AgentAdapter } from "../adapters/types.js";
import {
  PERMISSION_TIERS,
  PolicyError,
  permissionRank,
  type PermissionTier,
  type ProviderId,
} from "../types.js";

export function parsePermission(value: string | undefined, fallback: PermissionTier): PermissionTier {
  if (value === undefined) return fallback;
  if ((PERMISSION_TIERS as readonly string[]).includes(value)) return value as PermissionTier;
  throw new PolicyError(
    `unknown permission "${value}"`,
    `Valid tiers, least to most privileged: ${PERMISSION_TIERS.join(", ")}`,
  );
}

/**
 * Enforce the permission ceiling.
 *
 * Rejects rather than clamps. Silently downgrading would hand back a run_id for
 * a worker that cannot do the job it was asked to do, and the caller would only
 * find out from a confusing failure much later.
 */
export function assertPermissionAllowed(
  cfg: Config,
  adapter: AgentAdapter,
  requested: PermissionTier,
): void {
  if (!adapter.capabilities.permissionTiers.includes(requested)) {
    throw new PolicyError(
      `${adapter.displayName} cannot express the "${requested}" permission tier`,
      `Supported: ${adapter.capabilities.permissionTiers.join(", ")}`,
    );
  }

  const ceiling = cfg.providers[adapter.id]?.maxPermission ?? "auto";
  if (permissionRank(requested) > permissionRank(ceiling)) {
    throw new PolicyError(
      `permission "${requested}" exceeds the ceiling for ${adapter.id} ("${ceiling}")`,
      `Raise providers.${adapter.id}.maxPermission in ~/.subagent/config.json to allow it.`,
    );
  }

  // `bypass` is never reachable from a tool argument alone. The model chooses
  // tool arguments; the developer chooses config.
  if (requested === "bypass" && !cfg.policy.allowBypass) {
    throw new PolicyError(
      'permission "bypass" requires policy.allowBypass',
      "Set policy.allowBypass to true in ~/.subagent/config.json. This lets a worker run any command without prompting — enable it only for sandboxed or disposable workspaces.",
    );
  }
}

export function assertProviderEnabled(cfg: Config, adapter: AgentAdapter): void {
  if (cfg.providers[adapter.id]?.enabled === false) {
    throw new PolicyError(
      `provider "${adapter.id}" is disabled`,
      `Set providers.${adapter.id}.enabled to true in ~/.subagent/config.json.`,
    );
  }
}

export function assertModelAllowed(cfg: Config, adapter: AgentAdapter, model: string | undefined): void {
  if (!model) return;
  const allowed = cfg.providers[adapter.id]?.models ?? [];
  if (allowed.length === 0) return; // empty allowlist means "no restriction"
  if (!allowed.includes(model)) {
    throw new PolicyError(
      `model "${model}" is not allowed for ${adapter.id}`,
      `Allowed: ${allowed.join(", ")}`,
    );
  }
}

export interface ConcurrencySnapshot {
  total: number;
  byProvider: Record<string, number>;
}

export function assertConcurrencyAvailable(
  cfg: Config,
  provider: ProviderId,
  snapshot: ConcurrencySnapshot,
): void {
  if (snapshot.total >= cfg.policy.maxConcurrent) {
    throw new PolicyError(
      `concurrency limit reached (${snapshot.total}/${cfg.policy.maxConcurrent} runs active)`,
      "Wait for a run to finish, cancel one, or raise policy.maxConcurrent.",
    );
  }
  const forProvider = snapshot.byProvider[provider] ?? 0;
  if (forProvider >= cfg.policy.maxConcurrentPerProvider) {
    throw new PolicyError(
      `per-provider limit reached for ${provider} (${forProvider}/${cfg.policy.maxConcurrentPerProvider})`,
      "Wait for a run to finish, or raise policy.maxConcurrentPerProvider.",
    );
  }
}
