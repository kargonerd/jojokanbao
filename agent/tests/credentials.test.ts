import { describe, expect, it } from "vitest";
import {
  PersistentCredentialStore,
  parseCredentialFile,
  type CredentialFile,
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
    const store = new PersistentCredentialStore({
      read: async () => structuredClone(persisted),
      write: async (credentials) => {
        persisted = structuredClone(credentials);
      },
    });

    await Promise.all(
      Array.from({ length: 5 }, () =>
        store.modify("openai-codex", async (current) => ({
          type: "oauth",
          access: String(
            Number(current?.type === "oauth" ? current.access : "0") + 1,
          ),
          refresh: current?.type === "oauth" ? current.refresh : "refresh",
          expires: current?.type === "oauth" ? current.expires : 0,
        }))),
    );

    expect(await store.read("openai-codex")).toMatchObject({ access: "5" });
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
