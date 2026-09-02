import { describe, expect, it } from "vitest";
import {
  PersistentCredentialStore,
  createCredentialAdminHandler,
  createPlatformModelRuntime,
  createEdgeOneCredentialStore,
  EdgeOneEncryptedCredentialPersistence,
  resolvePlatformModelConfig,
} from "../src";

class MemoryMessageStore {
  values: string[] = [];

  async getMessages(input: { limit?: number; order?: "asc" | "desc" }) {
    const messages = this.values.map((content, index) => ({
      messageId: `message-${index + 1}`,
      role: "system" as const,
      content,
    }));
    if (input.order === "desc") messages.reverse();
    return messages.slice(0, input.limit);
  }

  async appendMessage(input: { content: unknown }) {
    this.values.push(String(input.content));
    return `message-${this.values.length}`;
  }

  async updateMessage(input: { messageId: string; content?: unknown }) {
    const index = Number(input.messageId.replace("message-", "")) - 1;
    this.values[index] = String(input.content);
    return {
      messageId: input.messageId,
      role: "system" as const,
      content: input.content,
    };
  }
}

function key(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

describe("EdgeOneEncryptedCredentialPersistence", () => {
  it("uses the deployed encryption key without storing plaintext tokens", async () => {
    const store = new MemoryMessageStore();
    const credentials = createEdgeOneCredentialStore(
      {
        JOJO_CREDENTIAL_ENCRYPTION_KEY: Buffer.from(key(3)).toString("base64"),
      },
      store,
    );
    await credentials.modify(
      "openai-codex",
      async () => ({
        type: "oauth",
        access: "private-access-token",
        refresh: "private-refresh-token",
        expires: 123,
      }),
    );

    await expect(credentials.read("openai-codex")).resolves.toMatchObject({
      type: "oauth",
      access: "private-access-token",
    });
    expect(store.values.at(-1)).not.toContain("private-access-token");
    expect(store.values.at(-1)).not.toContain("private-refresh-token");

    await credentials.modify("openai-codex", async (current) => ({
      ...current!,
      access: "refreshed-access-token",
    }));
    expect(store.values).toHaveLength(1);

    const secondInstance = createEdgeOneCredentialStore(
      {
        JOJO_CREDENTIAL_ENCRYPTION_KEY: Buffer.from(key(3)).toString("base64"),
      },
      store,
    );
    await expect(secondInstance.read("openai-codex")).resolves.toMatchObject({
      type: "oauth",
      refresh: "private-refresh-token",
    });
  });

  it("cannot decrypt credentials with a different project key", async () => {
    const store = new MemoryMessageStore();
    const first = new EdgeOneEncryptedCredentialPersistence(
      store,
      key(1),
    );
    await first.write({
      "openai-codex": {
        type: "oauth",
        access: "access",
        refresh: "refresh",
        expires: 123,
      },
    });

    await expect(
      new EdgeOneEncryptedCredentialPersistence(store, key(2)).read(),
    ).rejects.toThrow();
  });

  it("recovers when another isolate wins a rotating-token refresh race", async () => {
    const messageStore = new MemoryMessageStore();
    await new EdgeOneEncryptedCredentialPersistence(messageStore, key(4)).write({
      "openai-codex": {
        type: "oauth",
        access: "expired-access",
        refresh: "shared-refresh",
        expires: 0,
      },
    });
    const firstStore = new PersistentCredentialStore(
      new EdgeOneEncryptedCredentialPersistence(messageStore, key(4)),
      { coordinationKey: "edge-isolate-one" },
    );
    const secondStore = new PersistentCredentialStore(
      new EdgeOneEncryptedCredentialPersistence(messageStore, key(4)),
      { coordinationKey: "edge-isolate-two" },
    );
    const [firstRuntime, secondRuntime] = await Promise.all([
      createPlatformModelRuntime({
        config: resolvePlatformModelConfig({}),
        credentials: firstStore,
      }),
      createPlatformModelRuntime({
        config: resolvePlatformModelConfig({}),
        credentials: secondStore,
      }),
    ]);

    const originalFetch = globalThis.fetch;
    let refreshCalls = 0;
    let notifySecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      notifySecondStarted = resolve;
    });
    globalThis.fetch = async () => {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        await secondStarted;
        return new Response(JSON.stringify({
          access_token: "winner-access",
          refresh_token: "winner-refresh",
          expires_in: 3_600,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      notifySecondStarted();
      return new Response(JSON.stringify({
        error: { code: "refresh_token_reused" },
      }), { status: 401, headers: { "content-type": "application/json" } });
    };

    try {
      const results = await Promise.all([
        firstRuntime.models.getAuth("openai-codex"),
        secondRuntime.models.getAuth("openai-codex"),
      ]);
      expect(results).toEqual([
        expect.objectContaining({ auth: { apiKey: "winner-access" } }),
        expect.objectContaining({ auth: { apiKey: "winner-access" } }),
      ]);
      expect(refreshCalls).toBe(2);
      await expect(firstStore.read("openai-codex")).resolves.toMatchObject({
        access: "winner-access",
        refresh: "winner-refresh",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps a claimed admin token family when an older runtime refresh finishes last", async () => {
    const messageStore = new MemoryMessageStore();
    await new EdgeOneEncryptedCredentialPersistence(messageStore, key(5)).write({
      "openai-codex": {
        type: "oauth",
        access: "old-access",
        refresh: "old-family-refresh",
        expires: 0,
        generation: 4,
      },
    });
    const runtimeStore = new PersistentCredentialStore(
      new EdgeOneEncryptedCredentialPersistence(messageStore, key(5)),
      { coordinationKey: "runtime-isolate" },
    );
    const adminStore = new PersistentCredentialStore(
      new EdgeOneEncryptedCredentialPersistence(messageStore, key(5)),
      { coordinationKey: "admin-isolate" },
    );
    const runtime = await createPlatformModelRuntime({
      config: resolvePlatformModelConfig({}),
      credentials: runtimeStore,
    });
    const handleAdmin = createCredentialAdminHandler({
      createCredentialStore: () => adminStore,
      claimCredential: async (credential) => ({
        ...credential,
        access: "admin-claimed-access",
        refresh: "admin-claimed-refresh",
        expires: Date.now() + 3_600_000,
      }),
    });

    const originalFetch = globalThis.fetch;
    let notifyRuntimeStarted!: () => void;
    const runtimeStarted = new Promise<void>((resolve) => {
      notifyRuntimeStarted = resolve;
    });
    let releaseRuntime!: () => void;
    const runtimeRelease = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    globalThis.fetch = async () => {
      notifyRuntimeStarted();
      await runtimeRelease;
      return new Response(JSON.stringify({
        access_token: "old-family-new-access",
        refresh_token: "old-family-new-refresh",
        expires_in: 3_600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    try {
      const pendingRuntimeAuth = runtime.models.getAuth("openai-codex");
      await runtimeStarted;
      const adminResponse = await handleAdmin({
        env: { JOJO_OPERATOR_TOKEN: "a".repeat(32) },
        request: new Request("https://agent.example.com/gateway/credentials", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${"a".repeat(32)}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            scope: "agent",
            provider: "openai-codex",
            credential: {
              type: "oauth",
              access: "admin-upload-access",
              refresh: "admin-independent-family",
              expires: 1,
            },
          }),
        }),
      });
      expect(adminResponse.status).toBe(204);
      expect(messageStore.values).toHaveLength(2);

      releaseRuntime();
      await expect(pendingRuntimeAuth).resolves.toMatchObject({
        auth: { apiKey: "old-family-new-access" },
      });

      const latestStore = new PersistentCredentialStore(
        new EdgeOneEncryptedCredentialPersistence(messageStore, key(5)),
      );
      await expect(latestStore.read("openai-codex")).resolves.toMatchObject({
        access: "admin-claimed-access",
        refresh: "admin-claimed-refresh",
        generation: 5,
      });
      expect(messageStore.values).toHaveLength(2);
    } finally {
      releaseRuntime();
      globalThis.fetch = originalFetch;
    }
  });
});
