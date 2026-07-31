import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { PermissionTier, ProviderId } from "./types.js";

export interface ProviderConfig {
  enabled: boolean;
  bin?: string;
  /** Empty means "no restriction" — pass whatever the caller asks for. */
  models: string[];
  defaultModel?: string;
  /** Highest permission tier this provider may ever be spawned with. */
  maxPermission: PermissionTier;
}

export interface Config {
  home: string;
  providers: Record<ProviderId, ProviderConfig>;
  workspaces: {
    roots: string[];
    named: Record<string, string>;
  };
  policy: {
    /** `bypass` is unreachable from a tool argument unless this is true. */
    allowBypass: boolean;
    maxConcurrent: number;
    maxConcurrentPerProvider: number;
    defaultTimeoutMs: number;
    defaultPermission: PermissionTier;
    bridgeByDefault: boolean;
    bridgeMaxBytes: number;
  };
  retention: {
    compressAfterDays: number;
    maxAgeDays: number;
    maxRuns: number;
    pruneOnStartup: boolean;
    pruneOnSpawn: boolean;
  };
}

export type FileConfig = {
  providers?: Partial<Record<ProviderId, Partial<ProviderConfig>>>;
  workspaces?: Partial<Config["workspaces"]>;
  policy?: Partial<Config["policy"]>;
  retention?: Partial<Config["retention"]>;
};

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function providerDefaults(): Record<ProviderId, ProviderConfig> {
  return {
    claude: { enabled: true, models: [], maxPermission: "auto" },
    codex: { enabled: true, models: [], maxPermission: "auto" },
    cursor: { enabled: true, models: [], maxPermission: "auto" },
    kiro: { enabled: true, models: [], maxPermission: "auto" },
    "cursor-cloud": { enabled: false, models: [], maxPermission: "auto" },
    "anthropic-managed": { enabled: false, models: [], maxPermission: "auto" },
  };
}

export function defaults(home: string): Config {
  return {
    home,
    providers: providerDefaults(),
    workspaces: {
      // Deny-by-default: with no roots configured, only explicitly named
      // workspaces resolve. Spawning an autonomous agent into an arbitrary
      // path is the most dangerous thing this server can do.
      roots: [],
      named: {},
    },
    policy: {
      allowBypass: false,
      maxConcurrent: 4,
      maxConcurrentPerProvider: 2,
      defaultTimeoutMs: 30 * 60 * 1000,
      defaultPermission: "edit",
      bridgeByDefault: true,
      bridgeMaxBytes: 32 * 1024,
    },
    retention: {
      compressAfterDays: 7,
      maxAgeDays: 14,
      maxRuns: 200,
      pruneOnStartup: true,
      pruneOnSpawn: true,
    },
  };
}

export function harnessHome(): string {
  return process.env["SUBAGENT_HOME"] ?? path.join(os.homedir(), ".subagent");
}

function envList(name: string): string[] | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function envNum(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function envBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return v === "1" || v.toLowerCase() === "true";
}

async function readFileConfig(home: string): Promise<FileConfig> {
  const file = path.join(home, "config.json");
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as FileConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`failed to read ${file}: ${(err as Error).message}`);
  }
}

/** Exported for tests: merge without touching process state. */
export function mergeConfig(home: string, file: FileConfig): Config {
  const base = defaults(home);
  const providers = { ...base.providers };
  for (const key of Object.keys(providers) as ProviderId[]) {
    const overrides = file.providers?.[key];
    if (overrides) providers[key] = { ...providers[key]!, ...overrides };
  }

  const roots = (envList("SUBAGENT_WORKSPACE_ROOTS") ?? file.workspaces?.roots ?? base.workspaces.roots).map(
    expandHome,
  );
  const named: Record<string, string> = {};
  for (const [name, target] of Object.entries(file.workspaces?.named ?? {})) {
    named[name] = expandHome(target);
  }

  return {
    home,
    providers,
    workspaces: { roots, named },
    policy: {
      allowBypass: envBool("SUBAGENT_ALLOW_BYPASS") ?? file.policy?.allowBypass ?? base.policy.allowBypass,
      maxConcurrent: envNum("SUBAGENT_MAX_CONCURRENT") ?? file.policy?.maxConcurrent ?? base.policy.maxConcurrent,
      maxConcurrentPerProvider:
        envNum("SUBAGENT_MAX_CONCURRENT_PER_PROVIDER") ??
        file.policy?.maxConcurrentPerProvider ??
        base.policy.maxConcurrentPerProvider,
      defaultTimeoutMs:
        envNum("SUBAGENT_DEFAULT_TIMEOUT_MS") ?? file.policy?.defaultTimeoutMs ?? base.policy.defaultTimeoutMs,
      defaultPermission: file.policy?.defaultPermission ?? base.policy.defaultPermission,
      bridgeByDefault: envBool("SUBAGENT_BRIDGE") ?? file.policy?.bridgeByDefault ?? base.policy.bridgeByDefault,
      bridgeMaxBytes:
        envNum("SUBAGENT_BRIDGE_MAX_BYTES") ?? file.policy?.bridgeMaxBytes ?? base.policy.bridgeMaxBytes,
    },
    retention: {
      compressAfterDays:
        envNum("SUBAGENT_COMPRESS_AFTER_DAYS") ??
        file.retention?.compressAfterDays ??
        base.retention.compressAfterDays,
      maxAgeDays: envNum("SUBAGENT_MAX_AGE_DAYS") ?? file.retention?.maxAgeDays ?? base.retention.maxAgeDays,
      maxRuns: envNum("SUBAGENT_MAX_RUNS") ?? file.retention?.maxRuns ?? base.retention.maxRuns,
      pruneOnStartup:
        envBool("SUBAGENT_PRUNE_ON_STARTUP") ?? file.retention?.pruneOnStartup ?? base.retention.pruneOnStartup,
      pruneOnSpawn:
        envBool("SUBAGENT_PRUNE_ON_SPAWN") ?? file.retention?.pruneOnSpawn ?? base.retention.pruneOnSpawn,
    },
  };
}

let cached: Config | undefined;

export async function loadConfig(force = false): Promise<Config> {
  if (cached && !force) return cached;
  const home = harnessHome();
  cached = mergeConfig(home, await readFileConfig(home));
  return cached;
}

export function resetConfigCache(): void {
  cached = undefined;
}
