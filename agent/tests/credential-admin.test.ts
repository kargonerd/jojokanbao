import {
  PersistentCredentialStore,
  type CredentialFile,
} from "../src";
import { describe, expect, it, vi } from "vitest";
import { createCredentialAdminHandler } from "../src";

const OPERATOR_TOKEN = "a".repeat(32);

function request(body: unknown, token = OPERATOR_TOKEN): Request {
  return new Request("https://agent.example.com/internal/credentials", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("createCredentialAdminHandler", () => {
  it("stores the uploaded Codex OAuth credential without returning it", async () => {
    let stored: CredentialFile = {};
    const credentials = new PersistentCredentialStore({
      read: async () => stored,
      write: async (next) => {
        stored = next;
      },
    });
    const handle = createCredentialAdminHandler({
      createCredentialStore: () => credentials,
    });

    const response = await handle({
      env: { JOJO_OPERATOR_TOKEN: OPERATOR_TOKEN },
      request: request({
        scope: "agent",
        provider: "openai-codex",
        credential: {
          type: "oauth",
          access: "access",
          refresh: "refresh",
          expires: 123,
        },
      }),
    });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(stored["openai-codex"]).toMatchObject({
      type: "oauth",
      refresh: "refresh",
    });
  });

  it("rejects an invalid administrator token before touching storage", async () => {
    const createCredentialStore = vi.fn();
    const handle = createCredentialAdminHandler({
      createCredentialStore,
    });

    const response = await handle({
      env: { JOJO_OPERATOR_TOKEN: OPERATOR_TOKEN },
      request: request({}, "wrong-token"),
    });

    expect(response.status).toBe(401);
    expect(createCredentialStore).not.toHaveBeenCalled();
  });

  it("allowlists and validates each supported scope/provider pair", async () => {
    const createCredentialStore = vi.fn();
    const handle = createCredentialAdminHandler({
      createCredentialStore,
    });

    const response = await handle({
      env: { JOJO_OPERATOR_TOKEN: OPERATOR_TOKEN },
      request: request({
        scope: "agent",
        provider: "openai-codex",
        credential: { type: "api_key", key: "not-oauth" },
      }),
    });

    expect(response.status).toBe(400);
    expect(createCredentialStore).not.toHaveBeenCalled();
  });

  it("rejects unregistered platform credential scopes", async () => {
    const createCredentialStore = vi.fn();
    const handle = createCredentialAdminHandler({
      createCredentialStore,
    });

    const response = await handle({
      env: { JOJO_OPERATOR_TOKEN: OPERATOR_TOKEN },
      request: request({
        scope: "search",
        provider: "elasticsearch",
        credential: { type: "api_key", key: "secret" },
      }),
    });

    expect(response.status).toBe(400);
    expect(createCredentialStore).not.toHaveBeenCalled();
  });
});
