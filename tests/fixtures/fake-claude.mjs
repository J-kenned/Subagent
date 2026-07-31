#!/usr/bin/env node
// Replays a claude-shaped stream-json run. Shapes are copied from a live
// `claude -p --output-format stream-json --verbose` capture.
//
// Behaviour is driven by the prompt (the last argv entry):
//   contains "FAIL"  -> emits result.is_error=true and still exits 0, which is
//                       what the real binary does
//   contains "SLOW"  -> never terminates, for timeout/cancel tests
//   otherwise        -> a clean successful run that edits a file

const argv = process.argv.slice(2);
const prompt = argv.at(-1) ?? "";
const sessionId = argv.includes("--session-id") ? argv[argv.indexOf("--session-id") + 1] : "scraped-session";

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

emit({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd(), model: "fake" });

if (prompt.includes("SLOW")) {
  setInterval(() => emit({ type: "system", subtype: "tick", session_id: sessionId }), 50);
} else if (prompt.includes("FAIL")) {
  emit({
    type: "result",
    subtype: "success",
    is_error: true,
    result: "Not logged in · Please run /login",
    terminal_reason: "api_error",
    session_id: sessionId,
  });
  // Exits 0 despite failing — the behaviour that makes exit codes unusable.
  process.exit(0);
} else {
  emit({
    type: "assistant",
    session_id: sessionId,
    message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/repo/out.ts" } }] },
  });
  emit({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text: "PROBE_OK" }] } });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "PROBE_OK",
    total_cost_usd: 0.0042,
    usage: { input_tokens: 12, output_tokens: 5 },
    session_id: sessionId,
  });
  process.exit(0);
}
