import { promises as fs } from "node:fs";
import type { AgentAdapter } from "../adapters/types.js";
import type { InheritedContext, ProviderId } from "../types.js";
import { partitionForProvider, type ContextFile, type ContextProfile } from "./discover.js";

export interface BridgeResult {
  /** Text to inject, or undefined when nothing needed bridging. */
  payload?: string;
  via: "system-prompt" | "prompt-prefix";
  inherited: InheritedContext;
}

/**
 * Priority when the byte budget is tight. Repo-wide agent briefs beat
 * tool-specific rule fragments — if only one file fits, it should be the one
 * describing the project.
 */
const PRIORITY: Record<ContextFile["kind"], number> = {
  "claude-md": 0,
  "agents-md": 1,
  "kiro-steering": 2,
  "cursor-rules": 3,
  "copilot-instructions": 4,
};

/**
 * Build the context a provider would otherwise never see.
 *
 * Six of the eleven documented repos on the author's machine carry a CLAUDE.md
 * and nothing else — dispatch codex or kiro into one of those without this and
 * the worker starts with no idea what the project is.
 *
 * Bridging is per-run and in-flight: nothing is ever written into the
 * developer's repo.
 */
export async function buildBridge(
  profile: ContextProfile,
  adapter: AgentAdapter,
  opts: { enabled: boolean; maxBytes: number },
): Promise<BridgeResult> {
  const { native, orphan } = partitionForProvider(profile, adapter.id);
  const via: BridgeResult["via"] = adapter.capabilities.systemPromptAppend
    ? "system-prompt"
    : "prompt-prefix";

  const nativeNames = native.map((f) => f.rel);

  if (!opts.enabled || orphan.length === 0) {
    return { via, inherited: { native: nativeNames, bridged: [], truncated: false } };
  }

  const ordered = [...orphan].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.rel.localeCompare(b.rel));

  const sections: string[] = [];
  const bridged: InheritedContext["bridged"] = [];
  let used = 0;
  let truncated = false;

  for (const file of ordered) {
    const remaining = opts.maxBytes - used;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    let content: string;
    try {
      content = await fs.readFile(file.path, "utf8");
    } catch {
      continue;
    }
    if (content.length > remaining) {
      content = `${content.slice(0, remaining)}\n\n[truncated — exceeded bridge byte budget]`;
      truncated = true;
    }
    used += content.length;
    sections.push(renderSection(file, content, adapter.id));
    bridged.push({ path: file.rel, bytes: content.length, via });
    if (truncated) break;
  }

  if (!sections.length) {
    return { via, inherited: { native: nativeNames, bridged: [], truncated } };
  }

  const payload = [
    "The following project context files exist in this workspace but are not in",
    `a format ${adapter.displayName} reads natively. They are the project's own`,
    "instructions and carry the same authority as if you had found them yourself.",
    "",
    ...sections,
  ].join("\n");

  return { payload, via, inherited: { native: nativeNames, bridged, truncated } };
}

function renderSection(file: ContextFile, content: string, provider: ProviderId): string {
  const nativeTo = file.nativeTo.length ? file.nativeTo.join(",") : "none";
  return [
    `<inherited-context path="${file.rel}" native-to="${nativeTo}" bridged-to="${provider}">`,
    content.trimEnd(),
    "</inherited-context>",
    "",
  ].join("\n");
}
