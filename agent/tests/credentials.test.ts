import { describe, expect, it } from "vitest";
import {
  PersistentCredentialStore,
  parseCredentialFile,
  type CredentialFile,
  type CredentialPersistence,
} from "../src";

describe("PersistentCredentialStore", () => {
  it("persists OAuth refreshes without exposing secrets from list", async () => {
    let persisted: CredentialFile = {};
    const store = new PersistentCredentialStore({
      read: async () => persisted,
      write: async (credentials) => {
        persisted = structuredClone(credentials);
      },
    });

    await store.modify("openai-codex", async () => ({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    }));

    expect(await store.list()).toEqual([
      { providerId: "openai-codex", type: "oauth" },
    ]);
    expect(await store.read("openai-codex")).toMatchObject({
      type: "oauth",
      access: "access-token",
    });
  });

  it("serializes concurrent credential refresh writes", async () => {
    let persisted: CredentialFile = {
      "openai-codex": {
        type: "oauth",
        access: "0",
        refresh: "refresh",
        expires: 0,
      },
    };
    const persistence: CredentialPersistence = {
      read: async () => structuredClone(persisted),
      write: async (credentials) => {
        persisted = structuredClone(credentials);
      },
    };
    const stores = [
      new PersistentCredentialStore(persistence, { coordinationKey: "shared" }),
      new PersistentCredentialStore(persistence, { coordinationKey: "shared" }),
    ];

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        stores[index % stores.length]!.modify("openai-codex", async (current) => ({
          type: "oauth",
          access: String(
            Number(current?.type === "oauth" ? current.access : "0") + 1,
          ),
          refresh: current?.type === "oauth" ? current.refresh : "refresh",
          expires: current?.type === "oauth" ? current.expires : 0,
        }))),
    );

    expect(await stores[0]!.read("openai-codex")).toMatchObject({ access: "5" });
  });

  it("serializes the whole persistence namespace across different providers", async () => {
    let persisted: CredentialFile = {};
    const persistence: CredentialPersistence = {
      read: async () => structuredClone(persisted),
      write: async (credentials) => {
        persisted = structuredClone(credentials);
      },
    };
    const first = new PersistentCredentialStore(persistence, { coordinationKey: "multi-provider" });
    const second = new PersistentCredentialStore(persistence, { coordinationKey: "multi-provider" });

    await Promise.all([
      first.modify("provider-a", async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { type: "api_key", key: "key-a" };
      }),
      second.modify("provider-b", async () => ({ type: "api_key", key: "key-b" })),
    ]);

    expect(persisted).toEqual({
      "provider-a": { type: "api_key", key: "key-a" },
      "provider-b": { type: "api_key", key: "key-b" },
    });
  });
});

describe("parseCredentialFile", () => {
  it("keeps only valid Pi credential entries", () => {
    expect(parseCredentialFile(JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "access",
        refresh: "refresh",
        expires: 1,
      },
      malformed: { type: "oauth", access: "missing-refresh" },
      invalid: { token: "ignored" },
    }))).toEqual({
      "openai-codex": expect.objectContaining({ type: "oauth" }),
    });
  });
});
