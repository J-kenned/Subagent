#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { adapterEnv, getAdapter, listAdapters } from "./adapters/registry.js";
import { spawnAgent, sendMessage, type SpawnRequest } from "./orchestrator.js";
import { registry } from "./runtime/registry.js";
import { bindServer, notifyMessage } from "./runtime/notifier.js";
import { readEvents } from "./runtime/storage.js";
import { ensureHome, pruneRuns } from "./runtime/cleanup.js";
import { discoverContext } from "./workspace/discover.js";
import { listWorkspaces, resolveWorkspace } from "./workspace/resolve.js";
import { PERMISSION_TIERS, isTerminalStatus } from "./types.js";

const VERSION = "0.1.0";

function ok(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(err: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const e = err as { name?: string; message?: string; hint?: string };
  const body = {
    error: e.name ?? "Error",
    message: e.message ?? String(err),
    ...(e.hint ? { hint: e.hint } : {}),
  };
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], isError: true };
}

const spawnShape = {
  provider: z.enum(["claude", "codex", "cursor", "kiro"]).describe("Which agent to run."),
  prompt: z.string().min(1).describe("The task. Self-contained — the worker cannot see this conversation."),
  workspace: z
    .string()
    .optional()
    .describe("Named workspace to run in. Call list_workspaces to see what is addressable."),
  cwd: z.string().optional().describe("Absolute directory, as an alternative to `workspace`. Must sit under a configured root."),
  model: z.string().optional().describe("Provider-specific model id."),
  permission: z
    .enum(PERMISSION_TIERS)
    .optional()
    .describe(
      "read = no writes or shell; edit = writes in workspace; auto = provider's judgement; bypass = no prompts (requires config opt-in).",
    ),
  agent: z.string().optional().describe("Named agent persona, for providers that support them."),
  label: z.string().optional().describe("Short human-readable tag for this run."),
  timeout_ms: z.number().int().positive().optional().describe("Wall-clock limit for a turn."),
  max_budget_usd: z.number().positive().optional().describe("Spend cap, where the provider supports one."),
  extra_dirs: z.array(z.string()).optional().describe("Additional read-access directories, where supported."),
  bridge: z
    .boolean()
    .optional()
    .describe("Inject context files this provider cannot read natively. Defaults to on."),
};

async function main(): Promise<void> {
  const cfg = await loadConfig();
  await ensureHome(cfg.home);

  const server = new McpServer(
    { name: "subagent", version: VERSION },
    { capabilities: { tools: {}, resources: { subscribe: true, listChanged: true }, logging: {} } },
  );
  bindServer(server.server);

  await registry.load();
  if (cfg.retention.pruneOnStartup) void pruneRuns().catch(() => {});

  // ---------------------------------------------------------------- discovery

  server.registerTool(
    "list_providers",
    {
      title: "List agent providers",
      description:
        "Which agents exist, what they can do, and whether they are authenticated right now. Call this before spawning if unsure — it prevents a wasted run against a provider that is missing or logged out.",
      inputSchema: {
        check_auth: z
          .boolean()
          .optional()
          .describe("Run a live auth probe per provider. Slower, but authoritative. Defaults to true."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ check_auth }) => {
      try {
        const config = await loadConfig();
        const checkAuth = check_auth !== false;
        const providers = await Promise.all(
          listAdapters().map(async (adapter) => {
            const pcfg = config.providers[adapter.id];
            const auth = checkAuth ? await adapter.preflight(adapterEnv(adapter, config)) : undefined;
            return {
              id: adapter.id,
              name: adapter.displayName,
              enabled: pcfg?.enabled !== false,
              max_permission: pcfg?.maxPermission ?? "auto",
              capabilities: adapter.capabilities,
              ...(auth ? { auth } : {}),
            };
          }),
        );
        return ok({ providers });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list_workspaces",
    {
      title: "List workspaces",
      description:
        "Directories an agent may be spawned into. Naming one returns its full context profile — which agent-brief files it holds and which providers can read them natively.",
      inputSchema: {
        workspace: z.string().optional().describe("Return the deep context profile for just this workspace."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspace }) => {
      try {
        const config = await loadConfig();
        if (workspace) {
          const resolved = await resolveWorkspace(config, { workspace });
          const profile = await discoverContext(resolved.name, resolved.path);
          return ok({ workspace: profile });
        }
        const all = await listWorkspaces(config);
        const profiles = await Promise.all(
          all.map(async (w) => {
            const profile = await discoverContext(w.name, w.path);
            return {
              name: w.name,
              path: w.path,
              git_branch: profile.gitBranch,
              context_files: profile.files.map((f) => ({ path: f.rel, native_to: f.nativeTo })),
            };
          }),
        );
        return ok({ roots: config.workspaces.roots, workspaces: profiles });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ------------------------------------------------------------------- spawn

  server.registerTool(
    "spawn_agent",
    {
      title: "Spawn an agent",
      description:
        "Launch a coding agent in a workspace. Returns a run_id immediately — the agent runs in the background and never blocks this conversation. The response reports exactly which project context the worker inherited.",
      inputSchema: spawnShape,
    },
    async (args) => {
      try {
        return ok(await spawnAgent(args as SpawnRequest));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "spawn_fanout",
    {
      title: "Spawn several agents at once",
      description:
        "Launch multiple agents in one call — different providers, different workspaces, or both. Each entry takes the same arguments as spawn_agent. Failures are reported per entry; one bad entry does not stop the rest.",
      inputSchema: {
        runs: z.array(z.object(spawnShape)).min(1).max(16).describe("The agents to launch."),
      },
    },
    async ({ runs }) => {
      const results = await Promise.all(
        runs.map(async (run) => {
          try {
            return { ok: true as const, ...(await spawnAgent(run as SpawnRequest)) };
          } catch (err) {
            const e = err as { name?: string; message?: string; hint?: string };
            return {
              ok: false as const,
              provider: run.provider,
              workspace: run.workspace ?? run.cwd,
              error: e.name ?? "Error",
              message: e.message ?? String(err),
              ...(e.hint ? { hint: e.hint } : {}),
            };
          }
        }),
      );
      return ok({
        spawned: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results,
      });
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Message a running agent",
      description:
        "Send a follow-up to an existing run, resuming its session. Only works for providers that expose a resumable session handle — check list_providers.capabilities.followUp.",
      inputSchema: {
        run_id: z.string().describe("Run to message."),
        message: z.string().min(1).describe("The follow-up."),
      },
    },
    async ({ run_id, message }) => {
      try {
        return ok(await sendMessage(run_id, message));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ---------------------------------------------------------------- observe

  server.registerTool(
    "list_runs",
    {
      title: "List runs",
      description:
        "Runs known to this harness, newest first. Pass run_ids for a cheap targeted status poll, or filter by status / provider / workspace.",
      inputSchema: {
        run_ids: z.array(z.string()).optional().describe("Only these runs."),
        status: z
          .enum(["created", "running", "waiting_on_parent", "completed", "failed", "cancelled", "timed_out"])
          .optional(),
        provider: z.string().optional(),
        workspace: z.string().optional(),
        active_only: z.boolean().optional().describe("Only runs that have not reached a terminal state."),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ run_ids, status, provider, workspace, active_only, limit }) => {
      try {
        const wanted = run_ids ? new Set(run_ids) : undefined;
        const rows = registry
          .list()
          .filter((m) => !wanted || wanted.has(m.runId))
          .filter((m) => !status || m.status === status)
          .filter((m) => !provider || m.provider === provider)
          .filter((m) => !workspace || m.workspace === workspace)
          .filter((m) => !active_only || !isTerminalStatus(m.status))
          .slice(0, limit ?? 50)
          .map((m) => ({
            run_id: m.runId,
            label: m.label,
            provider: m.provider,
            status: m.status,
            workspace: m.workspace,
            model: m.model,
            permission: m.permission,
            last_seq: m.lastSeq,
            created_at: m.createdAt,
            ended_at: m.endedAt,
            summary: m.summary ? m.summary.replace(/\s+/g, " ").slice(0, 200) : undefined,
          }));
        return ok({ count: rows.length, active: registry.concurrency(), runs: rows });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_events",
    {
      title: "Tail a run's events",
      description:
        "Normalized events for a run since a sequence number. Every provider's output uses the same envelope, so this reads identically whichever agent produced it.",
      inputSchema: {
        run_id: z.string(),
        since_seq: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        kinds: z
          .array(z.enum(["lifecycle", "text", "reasoning", "tool_call", "tool_result", "usage", "error", "result"]))
          .optional()
          .describe("Filter to these event kinds. Omit for everything."),
        include_raw: z.boolean().optional().describe("Include the vendor payload. Verbose; defaults to false."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ run_id, since_seq, limit, kinds, include_raw }) => {
      try {
        const meta = registry.getMeta(run_id);
        if (!meta) return fail(new Error(`unknown run ${run_id}`));
        const wanted = kinds ? new Set(kinds) : undefined;
        const events = (await readEvents(run_id, since_seq ?? 0, (limit ?? 100) * 4))
          .filter((e) => !wanted || wanted.has(e.kind))
          .slice(0, limit ?? 100)
          .map((e) => (include_raw ? e : { ...e, raw: undefined }));
        return ok({
          run_id,
          status: meta.status,
          last_seq: meta.lastSeq,
          returned: events.length,
          events,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_result",
    {
      title: "Get a run's result",
      description:
        "Structured completion payload for a finished run: status, summary, artifacts, usage. Call this once a run reaches a terminal state.",
      inputSchema: { run_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ run_id }) => {
      try {
        const meta = registry.getMeta(run_id);
        if (!meta) return fail(new Error(`unknown run ${run_id}`));
        if (!isTerminalStatus(meta.status)) {
          return ok({
            run_id,
            status: meta.status,
            pending: true,
            message: "Run has not finished. Poll list_runs, or wait for the completion hook to report it.",
          });
        }
        const outcome = meta.outcome;
        return ok({
          run_id,
          provider: meta.provider,
          workspace: meta.workspace,
          status: meta.status,
          duration_ms: meta.endedAt && meta.startedAt ? meta.endedAt - meta.startedAt : undefined,
          inherited_context: meta.inheritedContext,
          summary: outcome?.summary ?? meta.summary ?? "",
          artifacts: outcome?.artifacts ?? [],
          open_questions: outcome?.openQuestions ?? [],
          usage: outcome?.usage,
          terminal_reason: outcome?.terminalReason,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ---------------------------------------------------------------- control

  server.registerTool(
    "cancel_agent",
    {
      title: "Cancel a run",
      description: "Terminate a running agent (SIGTERM). Its partial events and outcome are preserved.",
      inputSchema: { run_id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ run_id }) => {
      try {
        const runner = registry.getRunner(run_id);
        if (!runner) return fail(new Error(`run ${run_id} is not active in this server process`));
        await runner.cancel();
        return ok({ run_id, status: registry.getMeta(run_id)?.status ?? "cancelled" });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "prune_runs",
    {
      title: "Prune stored runs",
      description:
        "Retention maintenance: compress old terminal runs, delete older ones, enforce the LRU cap. Non-terminal runs are never touched. Use dry_run to preview.",
      inputSchema: {
        compress_after_days: z.number().min(0).optional(),
        max_age_days: z.number().min(0).optional(),
        keep_last: z.number().int().min(0).optional(),
        dry_run: z.boolean().optional(),
      },
      annotations: { destructiveHint: true },
    },
    async ({ compress_after_days, max_age_days, keep_last, dry_run }) => {
      try {
        return ok(
          await pruneRuns({
            ...(compress_after_days !== undefined ? { compressAfterDays: compress_after_days } : {}),
            ...(max_age_days !== undefined ? { maxAgeDays: max_age_days } : {}),
            ...(keep_last !== undefined ? { keepLast: keep_last } : {}),
            ...(dry_run !== undefined ? { dryRun: dry_run } : {}),
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // -------------------------------------------------------------- resources

  server.registerResource(
    "run-status",
    "subagent://runs",
    { description: "Status of every known run", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(registry.list(), null, 2) }],
    }),
  );

  server.registerResource(
    "workspaces",
    "subagent://workspaces",
    { description: "Addressable workspaces and their context files", mimeType: "application/json" },
    async (uri) => {
      const config = await loadConfig();
      const all = await listWorkspaces(config);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(all, null, 2) }],
      };
    },
  );

  await server.connect(new StdioServerTransport());

  // Startup diagnostics land in the MCP log so an operator sees provider
  // readiness immediately rather than discovering it on a failed spawn.
  void (async () => {
    for (const adapter of listAdapters()) {
      if (cfg.providers[adapter.id]?.enabled === false) continue;
      const auth = await adapter.preflight(adapterEnv(adapter, cfg));
      notifyMessage(
        auth.authenticated ? "info" : "warning",
        "startup",
        auth.authenticated
          ? `${adapter.id}: ready${auth.account ? ` (${auth.account})` : ""}`
          : `${adapter.id}: ${auth.reason ?? "unavailable"}${auth.remedy ? ` → ${auth.remedy}` : ""}`,
      );
    }
  })().catch(() => {});
}

main().catch((err: unknown) => {
  process.stderr.write(`subagent-mcp failed to start: ${(err as Error).message}\n`);
  process.exit(1);
});
