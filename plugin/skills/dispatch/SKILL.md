---
name: dispatch
description: Delegate work to another coding agent (claude, codex, cursor, kiro) in this or another repo. Use when the user says "have codex…", "send this to cursor", "run that in project2", "do X while I do Y", or asks for several agents at once.
---

# Dispatching agents

You can hand work to another coding agent running in any allowlisted workspace.
Dispatched agents are **asynchronous** — you get a `run_id` immediately and keep
talking to the user.

## The rule that matters most

**Never block on a subagent.** After `spawn_agent` returns, tell the user what
is running and carry on with the conversation. Do not poll in a loop, and do not
sit waiting. Completions arrive on their own via the completion hook, and you
report them then.

## Before you spawn

Call `list_providers` if you are unsure whether a provider is installed and
logged in, and `list_workspaces` if you are unsure a directory is addressable.
Both are cheap and prevent a wasted run.

## Spawning

```
spawn_agent({
  provider:   "codex",              // claude | codex | cursor | kiro
  workspace:  "project2",           // a name from list_workspaces
  prompt:     "…",                  // self-contained
  permission: "edit",               // read | edit | auto | bypass
  label:      "auth review",
})
```

For several at once, use `spawn_fanout` in a single call rather than repeated
`spawn_agent` calls — one round trip, and the runs start together.

### Writing the prompt

The worker **cannot see this conversation**. Everything it needs goes in the
prompt: the goal, the constraints, what "done" looks like, and where to report.
Write it as a standalone task brief.

It *will* see the workspace's own context files — that part is handled for you.

### Choosing a permission tier

| Tier | Use when |
|---|---|
| `read` | Review, audit, analysis. No writes, no shell. |
| `edit` | The default. The agent should change files in its workspace. |
| `auto` | Long autonomous work where the provider should use its own judgement. |
| `bypass` | Only if the user explicitly says "let it rip" — and it still requires config opt-in, so expect a rejection if they have not enabled it. |

Pick the lowest tier that can do the job. Match the user's own posture: if they
have you in plan mode, dispatch at `read`.

## Context inheritance — read the spawn response

The response reports what the worker inherited:

```jsonc
"inherited_context": {
  "native":  ["AGENTS.md"],
  "bridged": [{ "path": "CLAUDE.md", "bytes": 2145, "via": "prompt-prefix" }]
}
```

- **native** — the worker found these itself.
- **bridged** — files this vendor cannot read natively, injected for it. A repo
  with only a `CLAUDE.md` would otherwise leave codex, cursor, and kiro with no
  project context at all.

If both lists are empty the workspace has no agent brief. Say so, and consider
putting the key conventions in the prompt yourself.

## Following up

`send_message({ run_id, message })` resumes a run's session. Check
`list_providers` first — `capabilities.followUp` is false for kiro, which
exposes no resumable handle. For those, spawn a fresh run instead.

## Reporting results

When the completion hook reports a finished run, tell the user **before**
continuing with whatever else you were doing. Lead with the outcome, not the
mechanics:

> codex/project2 finished — no auth bypass found, but a timing-unsafe token
> compare at `src/auth/token.ts:88`. Patch attached.

Use `get_result` for the structured payload and `get_events` if you need to see
what the agent actually did.

## When not to dispatch

- The task needs this conversation's context to make sense. Do it yourself.
- It is a quick read or a single-file edit. Dispatching costs more than doing it.
- The user wants a second opinion on something you just wrote — that is a
  legitimate use, but say which agent you are asking and why.
