import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonCredentialStore } from "../src/credential-store.js";

describe("JsonCredentialStore", () => {
  let directory: string;
  let store: JsonCredentialStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "jojo-pi-auth-"));
    store = new JsonCredentialStore(join(directory, "auth.json"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("persists credentials but only lists non-secret metadata", async () => {
    await store.modify("openai-codex", async () => ({
      type: "oauth",
      access: "private-access-token",
      refresh: "private-refresh-token",
      expires: Date.now() + 60_000,
    }));

    expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
    expect((await store.read("openai-codex"))?.type).toBe("oauth");

    await store.delete("openai-codex");
    expect(await store.list()).toEqual([]);
  });

  it("serializes concurrent refresh writes for a provider", async () => {
    await store.modify("openai-codex", async () => ({
      type: "oauth",
      access: "first",
      refresh: "refresh",
      expires: 1,
      revision: 0,
    }));

    await Promise.all(
      Array.from({ length: 5 }, () =>
        store.modify("openai-codex", async (current) => ({
          ...(current as { type: "oauth"; access: string; refresh: string; expires: number; revision: number }),
          revision: Number(current?.revision ?? 0) + 1,
        })),
      ),
    );

    expect((await store.read("openai-codex"))?.revision).toBe(5);
  });
});
