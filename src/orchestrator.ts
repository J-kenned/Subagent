import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { adapterEnv, getAdapter } from "./adapters/registry.js";
import {
  assertConcurrencyAvailable,
  assertModelAllowed,
  assertPermissionAllowed,
  assertProviderEnabled,
  parsePermission,
} from "./policy/index.js";
import { CapabilityError, PolicyError, type InheritedContext, type RunMeta, type RunSpec } from "./types.js";
import { resolveWorkspace } from "./workspace/resolve.js";
import { discoverContext } from "./workspace/discover.js";
import { buildBridge } from "./workspace/bridge.js";
import { registry } from "./runtime/registry.js";
import { Runner } from "./runtime/runner.js";
import { appendMessage, ensureRunDir, writeBridgedContext, writeMeta } from "./runtime/storage.js";
import { notifyMessage } from "./runtime/notifier.js";
import { pruneRuns } from "./runtime/cleanup.js";
import { harnessSessionId } from "./session.js";

export interface SpawnRequest {
  provider: string;
  prompt: string;
  workspace?: string;
  cwd?: string;
  model?: string;
  permission?: string;
  agent?: string;
  label?: string;
  timeout_ms?: number;
  max_budget_usd?: number;
  extra_dirs?: string[];
  bridge?: boolean;
}

export interface SpawnResponse {
  run_id: string;
  provider: string;
  status: string;
  workspace: string;
  cwd: string;
  permission: string;
  model?: string;
  label?: string;
  inherited_context: InheritedContext;
  note?: string;
}

/**
 * The spawn path.
 *
 * Ordering matters: every check that can reject happens before a process is
 * started, so a rejected spawn leaves nothing behind.
 */
export async function spawnAgent(req: SpawnRequest): Promise<SpawnResponse> {
  const cfg = await loadConfig();
  const adapter = getAdapter(req.provider);

  assertProviderEnabled(cfg, adapter);

  const permission = parsePermission(req.permission, cfg.policy.defaultPermission);
  assertPermissionAllowed(cfg, adapter, permission);
  assertModelAllowed(cfg, adapter, req.model);
  assertConcurrencyAvailable(cfg, adapter.id, registry.concurrency());

  if (req.agent && !adapter.capabilities.namedAgents) {
    throw new CapabilityError(
      adapter.id,
      "namedAgents",
      `${adapter.displayName} does not support named agents; drop the "agent" argument.`,
    );
  }
  if (req.max_budget_usd && !adapter.capabilities.spendCap) {
    throw new CapabilityError(
      adapter.id,
      "spendCap",
      `${adapter.displayName} cannot enforce a spend cap; use timeout_ms instead.`,
    );
  }

  const workspace = await resolveWorkspace(cfg, {
    ...(req.workspace ? { workspace: req.workspace } : {}),
    ...(req.cwd ? { cwd: req.cwd } : {}),
  });

  const env = adapterEnv(adapter, cfg);
  const auth = await adapter.preflight(env);
  if (!auth.authenticated) {
    // Never spawn into a guaranteed failure — a run_id for a run that cannot
    // start is worse than an error the caller can act on.
    throw new PolicyError(
      `${adapter.displayName} is not ready: ${auth.reason ?? "unknown"}`,
      auth.remedy ?? "Check the provider's authentication.",
    );
  }

  const profile = await discoverContext(workspace.name, workspace.path);
  const bridge = await buildBridge(profile, adapter, {
    enabled: req.bridge ?? cfg.policy.bridgeByDefault,
    maxBytes: cfg.policy.bridgeMaxBytes,
  });

  const runId = randomUUID();
  const preassignedHandle =
    adapter.capabilities.sessionHandle === "preassigned" ? randomUUID() : undefined;

  const extraDirs = adapter.capabilities.extraDirs ? (req.extra_dirs ?? []) : [];

  const now = Date.now();
  const meta: RunMeta = {
    runId,
    provider: adapter.id,
    target: "local",
    status: "created",
    permission,
    workspace: workspace.name,
    cwd: workspace.path,
    createdAt: now,
    startedAt: now,
    lastSeq: 0,
    turns: [],
    initialPrompt: req.prompt,
    timeoutMs: req.timeout_ms ?? cfg.policy.defaultTimeoutMs,
    inheritedContext: bridge.inherited,
    spawnedBySession: harnessSessionId(),
    ...(req.label ? { label: req.label } : {}),
    ...(req.model ? { model: req.model } : {}),
    ...(req.agent ? { agent: req.agent } : {}),
    ...(req.max_budget_usd ? { maxBudgetUsd: req.max_budget_usd } : {}),
    ...(preassignedHandle ? { sessionHandle: preassignedHandle } : {}),
  };

  await ensureRunDir(runId);
  await writeMeta(meta);
  if (bridge.payload) await writeBridgedContext(runId, bridge.payload);

  const spec: RunSpec = {
    runId,
    provider: adapter.id,
    target: "local",
    prompt: req.prompt,
    cwd: workspace.path,
    workspace: workspace.name,
    permission,
    extraDirs,
    ...(req.model ? { model: req.model } : {}),
    ...(req.agent ? { agent: req.agent } : {}),
    ...(meta.timeoutMs ? { timeoutMs: meta.timeoutMs } : {}),
    ...(req.max_budget_usd ? { maxBudgetUsd: req.max_budget_usd } : {}),
    ...(preassignedHandle ? { sessionHandle: preassignedHandle } : {}),
  };

  const runner = new Runner(meta, adapter);
  registry.add(meta, runner);

  const turn = await runner.startTurn({
    spec,
    message: req.prompt,
    kind: "spawn",
    bin: env.bin,
    env: env.env,
    ...(bridge.payload ? { bridgedContext: bridge.payload } : {}),
    ...(preassignedHandle ? { preassignedHandle } : {}),
  });

  await appendMessage({
    messageId: randomUUID(),
    runId,
    turnId: turn.turnId,
    direction: "parent_to_worker",
    content: req.prompt,
    timestamp: turn.startedAt,
  });

  notifyMessage("info", runId, `spawned ${adapter.id} in ${workspace.name} (permission=${permission})`);

  if (cfg.retention.pruneOnSpawn) void pruneRuns().catch(() => {});

  const bridgedNote = bridge.inherited.bridged.length
    ? `Bridged ${bridge.inherited.bridged.map((b) => b.path).join(", ")} into ${adapter.displayName} via ${bridge.via}.`
    : undefined;

  return {
    run_id: runId,
    provider: adapter.id,
    status: meta.status,
    workspace: workspace.name,
    cwd: workspace.path,
    permission,
    inherited_context: bridge.inherited,
    ...(req.model ? { model: req.model } : {}),
    ...(req.label ? { label: req.label } : {}),
    ...(bridgedNote ? { note: bridgedNote } : {}),
  };
}

export async function sendMessage(runId: string, message: string): Promise<{ run_id: string; status: string; turn_id: string }> {
  const cfg = await loadConfig();
  const meta = registry.getMeta(runId);
  if (!meta) throw new Error(`unknown run ${runId}`);

  const adapter = getAdapter(meta.provider);
  if (!adapter.capabilities.followUp) {
    throw new CapabilityError(
      adapter.id,
      "followUp",
      `${adapter.displayName} cannot receive follow-up messages — it exposes no resumable session handle. Spawn a new run instead.`,
    );
  }
  if (!meta.sessionHandle) {
    throw new Error(`run ${runId} has no session handle yet; wait for it to establish one.`);
  }

  const runner = registry.getRunner(runId);
  if (!runner) {
    throw new Error(`run ${runId} is not owned by this server process and cannot be resumed.`);
  }
  if (runner.isBusy()) {
    throw new Error(`run ${runId} is busy with a turn already in flight.`);
  }

  const env = adapterEnv(adapter, cfg);
  const spec: RunSpec = {
    runId,
    provider: adapter.id,
    target: "local",
    prompt: message,
    cwd: meta.cwd,
    permission: meta.permission,
    extraDirs: [],
    ...(meta.workspace ? { workspace: meta.workspace } : {}),
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.timeoutMs ? { timeoutMs: meta.timeoutMs } : {}),
    sessionHandle: meta.sessionHandle,
  };

  const turn = await runner.startTurn({
    spec,
    message,
    kind: "resume",
    bin: env.bin,
    env: env.env,
    preassignedHandle: meta.sessionHandle,
  });

  await appendMessage({
    messageId: randomUUID(),
    runId,
    turnId: turn.turnId,
    direction: "parent_to_worker",
    content: message,
    timestamp: turn.startedAt,
  });

  return { run_id: runId, status: "running", turn_id: turn.turnId };
}
