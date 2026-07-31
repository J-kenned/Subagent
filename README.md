# subagent

An MCP server that lets Claude dispatch **any** coding agent — `claude`, `codex`,
`cursor-agent`, `kiro-cli` — into **any** repo on your machine, asynchronously.

```
You:     Have codex review the auth module in project2 while claude drafts
         the migration in project3. Ping me when both land.

Claude:  Two agents running.
           • codex   → project2   inherits: CLAUDE.md (bridged → prompt)
           • claude  → project3   inherits: CLAUDE.md, AGENTS.md
         Carry on — I'll report back as they finish.
```

Design docs: [PRD](./docs/PRD.md) · [Architecture](./docs/ARCHITECTURE.md).

Generalised from [`cursor-dispatcher`](https://github.com/ppetko98/cursor-dispatcher)
by ppetko98, which does this for Cursor alone.

---

## Why

Two problems, one server.

**Four vendors, four dialects.** Every agent CLI has its own headless grammar,
stream format, resume mechanism, and permission flags. `spawn_agent` is one verb
across all of them.

**A dispatched agent starts cold.** Each vendor auto-discovers project context
from a *different* file:

| Agent | Reads |
|---|---|
| `claude` | `CLAUDE.md` |
| `codex` | `AGENTS.md` |
| `cursor-agent` | `.cursor/rules/`, `AGENTS.md` |
| `kiro-cli` | `.kiro/steering/` |

On this author's machine, **6 of 11 documented repos carry a `CLAUDE.md` and
nothing else**. Send codex or kiro into one of those today and it inherits
nothing — it will happily violate conventions the repo states explicitly.

This server closes that gap. It discovers every context file in the target
workspace, works out which ones the chosen provider cannot read, and injects
them — through `--append-system-prompt` where the vendor has one, a labelled
prompt prefix otherwise. Nothing is ever written into your repo.

---

## Install

Requires Node ≥ 20, plus whichever agent CLIs you want to dispatch.

```bash
git clone https://github.com/J-kenned/subagent.git
cd subagent
npm install && npm run build
```

As a Claude Code plugin — wires up the MCP server, completion hooks, skill, and
slash commands:

```
/plugin marketplace add /absolute/path/to/subagent
/plugin install subagent@subagent
```

Or MCP-only:

```bash
claude mcp add subagent -- node /absolute/path/to/subagent/dist/server.js
```

Then configure at least one workspace root — **nothing is addressable until you
do**, by design:

```bash
mkdir -p ~/.subagent && cat > ~/.subagent/config.json <<'JSON'
{ "workspaces": { "roots": ["~/GitHub"] } }
JSON
```

Verify with `/subagent-doctor`.

---

## Tools

| Tool | Purpose |
|---|---|
| `spawn_agent` | Launch one agent. Returns a `run_id` immediately. |
| `spawn_fanout` | Launch several at once, across providers and workspaces. |
| `send_message` | Follow up on a run, resuming its session. |
| `list_runs` | Filter by status/provider/workspace, or poll specific `run_ids`. |
| `get_events` | Tail normalized events since a sequence number. |
| `get_result` | Structured terminal payload: status, summary, artifacts, usage. |
| `cancel_agent` | Stop a run. |
| `prune_runs` | Retention maintenance, with `dry_run`. |
| `list_providers` | What's installed, what it can do, whether it's logged in. |
| `list_workspaces` | What's addressable, and what context lives there. |

Resources: `subagent://runs`, `subagent://workspaces`.

---

## Providers

Capabilities are **declared**, not assumed. The harness degrades honestly rather
than flattening every vendor to the weakest one.

| | `claude` | `codex` | `cursor` | `kiro` |
|---|---|---|---|---|
| Stream | ndjson | ndjson | ndjson | text only |
| Session handle | preassigned | scraped | scraped | none |
| Follow-up | ✅ | ✅ | ✅ | ❌ |
| System-prompt bridging | ✅ | — | — | — |
| Named agents | ✅ | — | — | ✅ |
| Spend cap | ✅ | — | — | — |

`kiro` cannot take follow-ups because it exposes no session id in headless mode
([kirodotdev/Kiro#9066](https://github.com/kirodotdev/Kiro/issues/9066)).
`send_message` against it returns a capability error rather than silently
starting a fresh conversation.

`codex` is not installed on the development machine; its adapter is written from
published flag docs and covered by fixture tests, not validated against the real
binary.

---

## Permissions

One ordered ladder across every vendor:

| Tier | Meaning |
|---|---|
| `read` | No writes, no shell. |
| `edit` | **Default.** Writes inside the workspace. |
| `auto` | The provider's own judgement. |
| `bypass` | Everything, no prompts. |

A request above the configured ceiling is **rejected, not clamped** — silently
downgrading would hand back a `run_id` for a worker that cannot do the job.

`bypass` additionally requires `policy.allowBypass: true` in the config file. It
is unreachable from a tool argument alone: the model chooses tool arguments, you
choose config.

---

## Safety

- **Deny by default.** No workspace roots configured means nothing is
  addressable. Paths are `realpath`d before the containment check, so a symlink
  cannot walk out of an allowlisted root.
- **Environment hygiene.** Child processes get an explicit per-provider
  allowlist, never `process.env`. A dispatched agent has no reason to receive
  your unrelated API keys.
- **Auth preflight.** Every spawn checks the provider is logged in first and
  fails with the exact remedy command, rather than handing back a `run_id` for a
  run that cannot start.
- **Audit trail.** Whatever was injected into a worker is written verbatim to
  `runs/<id>/bridged-context.md`.

---

## Configuration

`~/.subagent/config.json` — see [`config.example.json`](./config.example.json).
Precedence: **env var > config file > built-in defaults.**

| Env | Overrides |
|---|---|
| `SUBAGENT_HOME` | data dir (default `~/.subagent`) |
| `SUBAGENT_WORKSPACE_ROOTS` | `workspaces.roots` (comma-separated) |
| `SUBAGENT_ALLOW_BYPASS` | `policy.allowBypass` |
| `SUBAGENT_MAX_CONCURRENT` | `policy.maxConcurrent` |
| `SUBAGENT_DEFAULT_TIMEOUT_MS` | `policy.defaultTimeoutMs` |
| `SUBAGENT_BRIDGE` | `policy.bridgeByDefault` |
| `SUBAGENT_BRIDGE_MAX_BYTES` | `policy.bridgeMaxBytes` |

---

## Storage

```
~/.subagent/
├── config.json
├── runs/<run_id>/
│   ├── meta.json             # status, provider, handles, turns, outcome
│   ├── events.ndjson         # normalized events (raw vendor payloads retained)
│   ├── messages.ndjson       # parent ↔ worker log
│   └── bridged-context.md    # exactly what was injected
└── hook-state/<session>.json
```

Retention: full for 7 days, gzipped to 14, deleted after, plus an LRU cap.
Non-terminal runs are never touched.

---

## Development

```bash
npm run check     # tsc --noEmit && vitest run
npm run build
```

Adapters are driven through **fake binaries** replaying recorded vendor streams,
so the suite is fast and hermetic and a vendor grammar change shows up as a
fixture diff rather than a production failure.

Two behaviours the tests pin down, both verified against real binaries:

- `claude -p --output-format stream-json` **requires `--verbose`** or it exits at
  argument parsing.
- `claude` **exits `0` on failure**, signalling the error only via
  `result.is_error`. Outcome derivation reads stream semantics, never the exit
  code alone.

### Adding a provider

One file in `src/adapters/` implementing `AgentAdapter` — capabilities,
`preflight`, `plan`, `createParser`, `deriveOutcome` — plus a line in
`adapters/registry.ts`. Tools, policy, storage, and workspaces do not change.

---

## Status

v0.1 scaffold. Local providers are implemented and tested end to end. Cloud
dispatch (Cursor Cloud Agents, Anthropic Managed Agents) is designed in
[ARCHITECTURE.md §9](./docs/ARCHITECTURE.md) but not yet implemented — the
adapter seam carries a `transport: "http"` variant for it.

## License

MIT
