import { describe, expect, it } from "vitest";
import {
  createEdgeOneCredentialStore,
  EdgeOneEncryptedCredentialPersistence,
} from "../src";

class MemoryMessageStore {
  values: string[] = [];

  async getMessages() {
    const content = this.values.at(-1);
    return content === undefined ? [] : [{
      messageId: `message-${this.values.length}`,
      role: "system" as const,
      content,
    }];
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
});
