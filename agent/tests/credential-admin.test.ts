import {
  PersistentCredentialStore,
  type CredentialFile,
} from "../src";
import { describe, expect, it, vi } from "vitest";
import { createCodexCredentialAdminHandler } from "../src";

const ADMIN_TOKEN = "a".repeat(32);

function request(body: unknown, token = ADMIN_TOKEN): Request {
  return new Request("https://agent.example.com/internal/codex-auth", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("createCodexCredentialAdminHandler", () => {
  it("stores the uploaded Codex OAuth credential without returning it", async () => {
    let stored: CredentialFile = {};
    const credentials = new PersistentCredentialStore({
      read: async () => stored,
      write: async (next) => {
        stored = next;
      },
    });
    const handle = createCodexCredentialAdminHandler({
      createCredentialStore: () => credentials,
    });

    const response = await handle({
      env: { CODEX_CREDENTIAL_ADMIN_TOKEN: ADMIN_TOKEN },
      request: request({
        "openai-codex": {
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
    const handle = createCodexCredentialAdminHandler({
      createCredentialStore,
    });

    const response = await handle({
      env: { CODEX_CREDENTIAL_ADMIN_TOKEN: ADMIN_TOKEN },
      request: request({}, "wrong-token"),
    });

    expect(response.status).toBe(401);
    expect(createCredentialStore).not.toHaveBeenCalled();
  });

  it("accepts only a Pi openai-codex OAuth credential", async () => {
    const createCredentialStore = vi.fn();
    const handle = createCodexCredentialAdminHandler({
      createCredentialStore,
    });

    const response = await handle({
      env: { CODEX_CREDENTIAL_ADMIN_TOKEN: ADMIN_TOKEN },
      request: request({
        "openai-codex": { type: "api_key", key: "not-oauth" },
      }),
    });

    expect(response.status).toBe(400);
    expect(createCredentialStore).not.toHaveBeenCalled();
  });
});
