---
description: Check which agent providers are installed, authenticated, and ready to dispatch
---

Run a readiness check on the subagent harness and report it plainly.

1. Call `list_providers` with `check_auth: true`.
2. Call `list_workspaces`.
3. Report a table: each provider's install state, auth state, and — for anything
   not ready — the exact remedy command from the `auth.remedy` field.
4. Report how many workspaces are addressable, and flag any that have **no**
   agent context files at all, since agents dispatched there start cold.
5. If no workspace roots are configured, say so and show the fix:

```json
{
  "workspaces": { "roots": ["~/GitHub"] }
}
```

written to `~/.subagent/config.json`.

Keep it short. The user wants to know what works and what to run to fix the rest.
