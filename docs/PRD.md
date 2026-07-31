# Subagent — dispatch any coding agent, anywhere

**Status:** draft v1
**Author:** John Kennedy
**Reference prior art:** [`cursor-dispatcher`](https://github.com/ppetko98/cursor-dispatcher) by ppetko98 — single-provider (Cursor) version of this idea. This document generalises it.

---

## 1. Working backwards: the customer

### Who

A developer who lives in Claude Code and has more than one coding agent installed — `claude`, `codex`, `cursor-agent`, `kiro-cli` — and more than one repo on disk. Concretely: 27 repos under `~/GitHub`, four agent CLIs on `$PATH`, one active conversation at a time.

### What they are trying to do

> *"Have Codex review the auth module in `project2` while Claude drafts the migration in `project3`. Tell me when they're both done."*

That sentence is the product. Everything below exists to make it a single turn of conversation.

### What they do today

To run one agent against another repo, the developer:

1. Opens a new terminal tab.
2. `cd ~/GitHub/project2`.
3. Recalls the right headless incantation for that vendor — `claude -p --output-format stream-json --verbose`, `codex exec --json`, `cursor-agent -p --output-format stream-json`, `kiro-cli chat --no-interactive --trust-all-tools`. All four differ.
4. Watches it, because there is no completion signal anywhere else.
5. Copies the useful part back into the Claude Code conversation by hand.

Doing that twice, in parallel, against two repos, means two terminals and two babysitting jobs. The main conversation — the one holding all the context about *why* this work is happening — is blocked the entire time or loses the thread entirely.

### The four frictions

| # | Friction | Cost |
|---|---|---|
| F1 | Every vendor has a different CLI grammar, stream format, resume mechanism, and permission flag | Developer must hold four dialects in their head; only ever uses the one they remember |
| F2 | Delegating blocks the main conversation, or the result never comes back | Context switch per task; results relayed by copy-paste |
| F3 | An agent spawned in another repo starts cold, or gets a hand-pasted prompt approximating the repo's conventions | Worse output than the same agent run natively in that repo |
| F4 | No record of what was delegated, to whom, with what result | Can't audit, can't resume, can't rerun |

### F3 deserves its own paragraph, because it is the interesting one

Every one of these agents auto-discovers project context from its working directory — and each reads a **different file**:

| Agent | Reads |
|---|---|
| `claude` | `CLAUDE.md` (walking up the tree) |
| `codex` | `AGENTS.md` |
| `cursor-agent` | `.cursor/rules/`, `AGENTS.md` |
| `kiro-cli` | `.kiro/steering/` |

Surveying the real repos on this machine:

```
Ai-config             CLAUDE.md
Ghost-Downloader-3    CLAUDE.md
Homelab               CLAUDE.md
Hyndricks             CLAUDE.md AGENTS.md
Shortcutey            CLAUDE.md AGENTS.md
Soteria               CLAUDE.md AGENTS.md
agent-native          CLAUDE.md AGENTS.md
cortextos             CLAUDE.md
laptop-setup          CLAUDE.md
my-vault              CLAUDE.md AGENTS.md
video-mate            CLAUDE.md
```

**Six of eleven documented repos carry `CLAUDE.md` and nothing else.** Dispatch Codex or Kiro into any of them today and it inherits *zero* project context — it will happily reformat code against conventions the repo explicitly rejects, because nobody told it. The developer's mental model ("my repo has an agent brief in it") is silently wrong for three of their four agents.

So the working directory is not a config field. **The working directory is the context payload** — and it is currently only legible to one vendor per repo.

---

## 2. The target experience

The developer stays in one conversation. They say what they want. Claude dispatches.

```
You:     Codex should review the auth module in project2 while Claude drafts
         the migration in project3. Ping me when both land.

Claude:  → spawn_fanout([
           { provider: "codex",  workspace: "project2", prompt: "Review src/auth…" },
           { provider: "claude", workspace: "project3", prompt: "Draft the migration…" },
         ])

         Two agents running.

         • codex   → project2   inherits: CLAUDE.md (bridged → AGENTS.md), 2 rules
         • claude  → project3   inherits: CLAUDE.md, AGENTS.md

         I'll report back as they finish — carry on.

You:     [keeps working on something else for six minutes]

You:     ok what's the state of the css refactor

Claude:  Before that — both agents finished.

         codex/project2  ✓ completed (4m12s)
           No auth bypass found. Two issues: timing-unsafe token compare at
           src/auth/token.ts:88, and a missing rotation check. Patch attached.

         claude/project3 ✓ completed (5m48s)
           Migration drafted at migrations/0042_tenant_split.sql, 3 files
           touched, tests pass.

         Now, the CSS refactor…
```

Three things make that work, and each is a design commitment:

1. **`spawn_fanout` returns immediately.** The developer's conversation is never blocked. Ever.
2. **`inherits:` is shown at spawn time.** The developer — and Claude — can see what the worker actually knows *before* it starts, and top it up if it looks thin. No silent cold starts.
3. **`(bridged → AGENTS.md)`** — Codex got project2's `CLAUDE.md` even though Codex doesn't read `CLAUDE.md`. This is the feature that turns F3 from a caveat into a solved problem.

### The second experience: cloud

Same tool, one field different.

```
You:     That refactor is going to take an hour. Send it to the cloud
         against the repo, and open a PR.

Claude:  → spawn_agent({ provider: "cursor", target: "cloud",
                         repo: "github.com/j/project2", prompt: "…" })

         Dispatched. Cloud agent bc-a91f. It runs without your laptop —
         you can close the lid. I'll have the PR link when it lands.
```

Local and cloud are the same verb with a different `target`. The developer should never have to learn a second mental model to move work off their machine.

---

## 3. Jobs to be done

| ID | Job | Delivered by |
|---|---|---|
| J1 | Delegate a task to a specific vendor's agent without leaving the conversation | `spawn_agent` |
| J2 | Run that agent inside another repo so it inherits that repo's conventions | Workspaces + context inheritance |
| J3 | Make sure the agent actually *gets* that context, whatever vendor it is | Context bridging |
| J4 | Fan several agents out at once, across repos or across vendors | `spawn_fanout` |
| J5 | Keep working; get told when they finish | Async runs + completion hooks |
| J6 | Ask a running agent a follow-up | `send_message` |
| J7 | Know which agents are even available and logged in before committing to one | `list_providers` |
| J8 | Move long work off the laptop | `target: "cloud"` |
| J9 | Audit and replay what was delegated | Run store + `list_runs` / `get_result` |
| J10 | Not have an autonomous agent run wild in the wrong directory | Policy layer |

---

## 4. Scope

### v1 — in

- **Local providers:** `claude`, `codex`, `cursor-agent`, `kiro-cli`.
- **Cloud providers:** Cursor Cloud Agents (REST), Anthropic Managed Agents (REST). Behind the same `spawn_agent` verb.
- **Workspaces:** named, allowlisted directory roots with context discovery and cross-vendor bridging.
- **Async lifecycle:** spawn → stream → terminal outcome, with structured results and normalized events.
- **Completion delivery** into the parent Claude Code conversation without polling.
- **Policy:** workspace allowlist, model allowlist, per-provider permission ceiling, concurrency cap, wall-clock and spend budgets.
- **Run store** on disk with retention and pruning.

### v1 — out

- Replacing Claude Code as the orchestrator. This is a dispatch layer, not a framework.
- Agent-to-agent topologies (workers spawning workers). One level of delegation.
- A GUI. The conversation is the interface.
- Automatic vendor selection. Claude picks the provider; the harness does not guess.
- Editing the developer's repos to add `AGENTS.md` files. Bridging is done in-flight, per run, and leaves the repo untouched.

### Explicit non-goal: uniform capability

Providers are not equal and v1 will not pretend they are. `kiro-cli` has no structured stream today; Cursor cannot pre-assign a session id; only `claude` accepts a spend cap. The harness **declares** these differences through a capability matrix and degrades honestly, rather than flattening everything to the weakest common denominator. A caller asking for structured output from Kiro gets told no, not given a silent approximation.

---

## 5. Success criteria

| Measure | Target |
|---|---|
| Time from "delegate this" to `run_id` returned | < 2s, always non-blocking |
| Conversation turns blocked while a subagent runs | 0 |
| Repos where a non-Claude agent inherits project context | 100% of workspaces with any context file (today: ~45%) |
| Vendor-specific flags the developer must remember | 0 |
| Adding a fifth provider | One adapter file, no changes to tools, storage, or policy |
| Terminal runs with a structured, machine-readable result | 100% |

The fifth-provider criterion is the real architectural test. If adding Gemini CLI or Amp requires touching `spawn_agent`, the abstraction failed.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| **An autonomous agent runs destructively in the wrong repo.** Highest-severity risk in the product. | Deny-by-default workspace allowlist; permission ceiling per provider; `bypass`-tier permissions require explicit opt-in config, never a tool argument alone |
| **Child agents don't inherit the parent's auth.** Observed during research: a spawned `claude` reported `Not logged in` with `apiKeySource: "none"`. | Per-provider auth preflight at startup and at every spawn, with an actionable error naming the exact login command. Never spawn into a guaranteed failure |
| **Exit codes lie.** Verified: `claude -p` exits `0` while emitting `result.is_error: true`. | Outcome derivation is per-adapter and reads stream semantics, never the exit code alone |
| Vendor CLI grammar drifts | Adapters are thin, declarative, and covered by fixture tests using fake binaries; a vendor change touches one file |
| Completion notification depends on Claude Code hook behaviour | Notifier is pluggable; ship `UserPromptSubmit` **and** `Stop` hooks so a change to either surface degrades rather than breaks |
| Cloud dispatch spends real money unattended | Budgets and concurrency caps apply to cloud targets too; cloud spawns are reported with their cost model up front |

---

## 7. Open questions

1. **Should a completed run's full transcript be summarised by the harness or handed raw to the parent?** Leaning: harness synthesises a bounded summary + artifacts, and exposes the raw stream on request. Cheap by default, complete on demand.
2. **Does context bridging need consent per run?** Bridging injects repo file contents into a third-party vendor's context window. For a public repo that is fine; for a private one the developer may want to know. Leaning: bridge by default within allowlisted workspaces, report it in the spawn response, and offer `bridge: false`.
3. **Codex CLI is not installed on this machine.** Its adapter is written from published flag documentation and covered by fixture tests, but has not been validated against the real binary. Flagged, not blocking.
