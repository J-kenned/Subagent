import { describe, expect, it } from "vitest";
import { mergeConfig } from "../src/config.js";
import {
  assertConcurrencyAvailable,
  assertModelAllowed,
  assertPermissionAllowed,
  assertProviderEnabled,
  parsePermission,
} from "../src/policy/index.js";
import { claudeAdapter } from "../src/adapters/claude.js";
import { kiroAdapter } from "../src/adapters/kiro.js";
import { adapterEnv } from "../src/adapters/registry.js";
import { PolicyError, permissionRank } from "../src/types.js";

const cfg = (over: Parameters<typeof mergeConfig>[1] = {}) => mergeConfig("/tmp/subagent-test", over);

describe("permission ladder", () => {
  it("is strictly ordered", () => {
    expect(permissionRank("read")).toBeLessThan(permissionRank("edit"));
    expect(permissionRank("edit")).toBeLessThan(permissionRank("auto"));
    expect(permissionRank("auto")).toBeLessThan(permissionRank("bypass"));
  });

  it("rejects an unknown tier", () => {
    expect(() => parsePermission("yolo", "edit")).toThrow(PolicyError);
  });

  it("falls back when unspecified", () => {
    expect(parsePermission(undefined, "edit")).toBe("edit");
  });
});

describe("permission ceiling", () => {
  it("allows a request at or below the ceiling", () => {
    const c = cfg({ providers: { claude: { maxPermission: "auto" } } });
    expect(() => assertPermissionAllowed(c, claudeAdapter, "edit")).not.toThrow();
    expect(() => assertPermissionAllowed(c, claudeAdapter, "auto")).not.toThrow();
  });

  it("rejects rather than silently clamping a request above the ceiling", () => {
    // Clamping would hand back a run_id for a worker that cannot do the job.
    const c = cfg({ providers: { claude: { maxPermission: "edit" } } });
    expect(() => assertPermissionAllowed(c, claudeAdapter, "auto")).toThrow(/exceeds the ceiling/);
  });

  it("gates bypass behind config, not a tool argument", () => {
    const withoutOptIn = cfg({ providers: { claude: { maxPermission: "bypass" } }, policy: { allowBypass: false } });
    expect(() => assertPermissionAllowed(withoutOptIn, claudeAdapter, "bypass")).toThrow(/allowBypass/);

    const withOptIn = cfg({ providers: { claude: { maxPermission: "bypass" } }, policy: { allowBypass: true } });
    expect(() => assertPermissionAllowed(withOptIn, claudeAdapter, "bypass")).not.toThrow();
  });

  it("defaults to denying bypass", () => {
    expect(cfg().policy.allowBypass).toBe(false);
  });

  it("rejects a tier the provider cannot express", () => {
    const narrowed = { ...kiroAdapter, capabilities: { ...kiroAdapter.capabilities, permissionTiers: ["read" as const] } };
    expect(() => assertPermissionAllowed(cfg(), narrowed, "edit")).toThrow(/cannot express/);
  });
});

describe("provider and model policy", () => {
  it("rejects a disabled provider", () => {
    const c = cfg({ providers: { claude: { enabled: false } } });
    expect(() => assertProviderEnabled(c, claudeAdapter)).toThrow(/disabled/);
  });

  it("treats an empty model allowlist as no restriction", () => {
    expect(() => assertModelAllowed(cfg(), claudeAdapter, "anything")).not.toThrow();
  });

  it("enforces a non-empty model allowlist", () => {
    const c = cfg({ providers: { claude: { models: ["opus", "sonnet"] } } });
    expect(() => assertModelAllowed(c, claudeAdapter, "sonnet")).not.toThrow();
    expect(() => assertModelAllowed(c, claudeAdapter, "gpt-5")).toThrow(/not allowed/);
  });
});

describe("concurrency", () => {
  it("enforces the global cap", () => {
    const c = cfg({ policy: { maxConcurrent: 2 } });
    expect(() => assertConcurrencyAvailable(c, "claude", { total: 2, byProvider: {} })).toThrow(
      /concurrency limit reached/,
    );
  });

  it("enforces the per-provider cap independently", () => {
    const c = cfg({ policy: { maxConcurrent: 10, maxConcurrentPerProvider: 1 } });
    expect(() => assertConcurrencyAvailable(c, "claude", { total: 1, byProvider: { claude: 1 } })).toThrow(
      /per-provider limit/,
    );
    // A different provider is unaffected by claude's saturation.
    expect(() => assertConcurrencyAvailable(c, "codex", { total: 1, byProvider: { claude: 1 } })).not.toThrow();
  });
});

describe("environment hygiene", () => {
  it("passes only the variables a provider declares", () => {
    process.env["SUBAGENT_TEST_SECRET"] = "do-not-leak";
    process.env["ANTHROPIC_API_KEY"] = "sk-test";
    try {
      const env = adapterEnv(claudeAdapter, cfg()).env;
      expect(env["ANTHROPIC_API_KEY"]).toBe("sk-test");
      // A dispatched worker has no business receiving the parent's unrelated
      // secrets.
      expect(env["SUBAGENT_TEST_SECRET"]).toBeUndefined();
    } finally {
      delete process.env["SUBAGENT_TEST_SECRET"];
      delete process.env["ANTHROPIC_API_KEY"];
    }
  });

  it("never forwards another provider's credentials", () => {
    process.env["CURSOR_API_KEY"] = "cur-secret";
    try {
      expect(adapterEnv(claudeAdapter, cfg()).env["CURSOR_API_KEY"]).toBeUndefined();
    } finally {
      delete process.env["CURSOR_API_KEY"];
    }
  });
});

describe("config defaults", () => {
  it("denies every directory until roots are configured", () => {
    expect(cfg().workspaces.roots).toEqual([]);
  });

  it("defaults to the edit tier, not auto", () => {
    expect(cfg().policy.defaultPermission).toBe("edit");
  });
});
