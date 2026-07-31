---
description: Show what dispatched agents are running and what has finished
---

Report the state of all dispatched agents.

1. Call `list_runs`.
2. Group into **running** and **recently finished**.
3. For running agents show: provider, workspace, label, and how long they have
   been going.
4. For finished agents show: provider, workspace, status, and a one-line summary.
5. If the user asks about a specific run, call `get_result` for the full payload,
   or `get_events` to show what it actually did.

If nothing is running and nothing has finished, say so in one line.
