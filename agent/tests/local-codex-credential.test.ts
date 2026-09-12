import path from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveLocalAgentAuthPath } from "../src/local-codex-credential";

describe("resolveLocalAgentAuthPath", () => {
  it("defaults to the Agent-owned credential file instead of the Codex app login", () => {
    expect(resolveLocalAgentAuthPath("C:/workspace/jojo", {})).toBe(
      path.join("C:/workspace/jojo", "agent", "auth.json"),
    );
  });

  it("allows an explicit Pi-compatible credential file", () => {
    expect(resolveLocalAgentAuthPath("C:/workspace/jojo", {
      JOJO_AGENT_AUTH_PATH: "secrets/agent-auth.json",
    })).toBe(path.resolve("C:/workspace/jojo", "secrets/agent-auth.json"));
  });

  it("keeps the legacy operator path as the explicit first choice", () => {
    expect(resolveLocalAgentAuthPath("C:/workspace/jojo", {
      JOJO_CODEX_AUTH_PATH: "operator/codex-auth.json",
      JOJO_AGENT_AUTH_PATH: "secrets/agent-auth.json",
    })).toBe(path.resolve("C:/workspace/jojo", "operator/codex-auth.json"));
  });

  it("reuses the primary checkout's Agent login for a worktree but prefers an explicit or local login", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "jojo-agent-auth-test-"));
    try {
      const worktree = path.join(fixture, "worktree");
      const primary = path.join(fixture, "primary");
      const primaryAuth = path.join(primary, "agent", "auth.json");
      const localAuth = path.join(worktree, "agent", "auth.json");
      mkdirSync(path.dirname(primaryAuth), { recursive: true });
      mkdirSync(path.dirname(localAuth), { recursive: true });
      writeFileSync(primaryAuth, "{}");
      expect(resolveLocalAgentAuthPath(worktree, {}, primary)).toBe(primaryAuth);
      expect(resolveLocalAgentAuthPath(worktree, { JOJO_AGENT_AUTH_PATH: "chosen.json" }, primary))
        .toBe(path.join(worktree, "chosen.json"));
      writeFileSync(localAuth, "{}");
      expect(resolveLocalAgentAuthPath(worktree, {}, primary)).toBe(localAuth);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
