import path from "node:path";
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
});
