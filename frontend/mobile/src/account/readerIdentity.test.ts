import type { JojoAuthStore, Profile } from "@jojo/auth";
import { create } from "zustand";
import { describe, expect, it, vi } from "vitest";
import { createReaderIdentityCache } from "./readerIdentity";

const user = { id: "reader-1" };
const profile = { id: user.id, display_name: "鬼石栎-KEB" } as Profile;
function setup(cached: string | null = null) {
  const auth = create(() => ({ user, profile: null as Profile | null, initialized: true })) as unknown as JojoAuthStore;
  let value = cached;
  const storage = {
    getItem: vi.fn(async () => value),
    setItem: vi.fn(async (_key: string, next: string) => { value = next; }),
    removeItem: vi.fn(async () => { value = null; }),
  };
  const identity = createReaderIdentityCache(auth, storage);
  return { auth, storage, identity };
}

describe("reader identity cache", () => {
  it("does not erase the saved name before a slow offline session is restored", async () => {
    const { auth, storage, identity } = setup(JSON.stringify({ userId: user.id, displayName: profile.display_name }));
    auth.setState({ user: null });
    const stop = identity.start();
    await Promise.resolve();
    expect(storage.removeItem).not.toHaveBeenCalled();
    auth.setState({ user: user as never });
    await vi.waitFor(() => expect(identity.useIdentityStore.getState().displayName).toBe(profile.display_name));
    stop();
  });
  it("restores the same reader's label while the network profile is unavailable", async () => {
    const { auth, storage, identity } = setup(JSON.stringify({ userId: user.id, displayName: profile.display_name }));
    const stop = identity.start();
    await vi.waitFor(() => expect(identity.useIdentityStore.getState().displayName).toBe(profile.display_name));
    expect(auth.getState().profile).toBeNull();
    expect(storage.setItem).not.toHaveBeenCalled();
    stop();
  });

  it("persists a fresh name and clears it from memory and storage on sign-out", async () => {
    const { auth, storage, identity } = setup();
    const stop = identity.start();
    auth.setState({ profile });
    await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledOnce());
    expect(identity.useIdentityStore.getState().displayName).toBe(profile.display_name);
    auth.setState({ user: null, profile: null });
    expect(identity.useIdentityStore.getState()).toEqual({ userId: null, displayName: null });
    await vi.waitFor(() => expect(storage.removeItem).toHaveBeenCalledOnce());
    stop();
  });

  it("ignores a delayed cache result after account switching", async () => {
    const { auth, storage, identity } = setup();
    let resolveRead!: (value: string) => void;
    storage.getItem.mockReturnValueOnce(new Promise((resolve) => { resolveRead = resolve; }));
    const stop = identity.start();
    auth.setState({ user: { id: "reader-2" } as never });
    resolveRead(JSON.stringify({ userId: user.id, displayName: profile.display_name }));
    await Promise.resolve();
    expect(identity.useIdentityStore.getState()).toEqual({ userId: "reader-2", displayName: null });
    stop();
  });

  it("does not let a late cached value overwrite a fresh server profile", async () => {
    const { auth, storage, identity } = setup();
    let resolveRead!: (value: string) => void;
    storage.getItem.mockReturnValueOnce(new Promise((resolve) => { resolveRead = resolve; }));
    const stop = identity.start();
    auth.setState({ profile });
    resolveRead(JSON.stringify({ userId: user.id, displayName: "旧代号-ABC" }));
    await Promise.resolve();
    expect(identity.useIdentityStore.getState().displayName).toBe(profile.display_name);
    stop();
  });

  it.each(["broken json", "null", JSON.stringify({ userId: "someone-else", displayName: profile.display_name })])("ignores invalid or unrelated cache: %s", async (cached) => {
    const { identity } = setup(cached);
    const stop = identity.start();
    await Promise.resolve();
    expect(identity.useIdentityStore.getState().displayName).toBeNull();
    stop();
  });

  it("continues showing the live name when device storage fails", async () => {
    const { auth, storage, identity } = setup();
    storage.getItem.mockRejectedValueOnce(new Error("storage unavailable"));
    storage.setItem.mockRejectedValueOnce(new Error("storage unavailable"));
    const stop = identity.start();
    auth.setState({ profile });
    await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledOnce());
    expect(identity.useIdentityStore.getState().displayName).toBe(profile.display_name);
    stop();
  });
});
