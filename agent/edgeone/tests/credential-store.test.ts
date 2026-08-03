import { describe, expect, it } from "vitest";
import {
  EdgeOneEncryptedCredentialPersistence,
} from "../src";

class MemoryBlobStore {
  value: string | undefined;

  async get() {
    return this.value;
  }

  async set(_key: string, value: string, options?: { onlyIfNew?: boolean }) {
    if (options?.onlyIfNew && this.value !== undefined) return;
    this.value = value;
  }
}

function key(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

describe("EdgeOneEncryptedCredentialPersistence", () => {
  it("seeds Codex OAuth into Blob without storing plaintext tokens", async () => {
    const blob = new MemoryBlobStore();
    const persistence = new EdgeOneEncryptedCredentialPersistence(
      blob,
      key(7),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "private-access-token",
          refresh: "private-refresh-token",
          expires: 123,
        },
      }),
    );

    expect(await persistence.read()).toMatchObject({
      "openai-codex": { type: "oauth", access: "private-access-token" },
    });
    expect(blob.value).not.toContain("private-access-token");
    expect(blob.value).not.toContain("private-refresh-token");

    const secondInstance = new EdgeOneEncryptedCredentialPersistence(blob, key(7));
    expect(await secondInstance.read()).toMatchObject({
      "openai-codex": { type: "oauth", refresh: "private-refresh-token" },
    });
  });

  it("cannot decrypt credentials with a different project key", async () => {
    const blob = new MemoryBlobStore();
    const first = new EdgeOneEncryptedCredentialPersistence(
      blob,
      key(1),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "access",
          refresh: "refresh",
          expires: 123,
        },
      }),
    );
    await first.read();

    await expect(
      new EdgeOneEncryptedCredentialPersistence(blob, key(2)).read(),
    ).rejects.toThrow();
  });
});
