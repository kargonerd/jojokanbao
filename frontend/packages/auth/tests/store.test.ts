import { describe, expect, it, vi } from "vitest";
import type { JojoAuthClient } from "../src/client";
import { createJojoAuthStore } from "../src/store";
import type { Profile } from "../src/types";

const profile: Profile = {
  id: "user-1",
  display_name: "JOJO",
  avatar_path: null,
  created_at: "2026-07-22T00:00:00Z",
  updated_at: "2026-07-22T00:00:00Z",
};

function createClient() {
  const user = { id: profile.id };
  const session = { user, access_token: "access-token" };
  const unsubscribe = vi.fn();
  const maybeSingle = vi.fn().mockResolvedValue({ data: profile, error: null });
  const signInWithPassword = vi.fn().mockResolvedValue({
    data: { user, session },
    error: null,
  });
  const getSession = vi.fn().mockResolvedValue({ data: { session }, error: null });
  const onAuthStateChange = vi.fn().mockReturnValue({
    data: { subscription: { unsubscribe } },
  });

  const client = {
    auth: {
      getSession,
      onAuthStateChange,
      signInWithPassword,
    },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ maybeSingle }),
      }),
    }),
  } as unknown as JojoAuthClient;

  return { client, getSession, signInWithPassword, unsubscribe, user };
}

describe("createJojoAuthStore", () => {
  it("hydrates the current session and disposes its auth subscription", async () => {
    const { client, getSession, unsubscribe, user } = createClient();
    const controller = createJojoAuthStore(client);

    const stop = controller.startAuthSync();

    await vi.waitFor(() => {
      expect(controller.useAuthStore.getState().initialized).toBe(true);
    });
    expect(getSession).toHaveBeenCalledOnce();
    expect(controller.useAuthStore.getState()).toMatchObject({ user, profile });

    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("signs in and loads the account profile", async () => {
    const { client, signInWithPassword, user } = createClient();
    const { useAuthStore } = createJojoAuthStore(client);

    await useAuthStore.getState().signIn("reader@example.com", "password");

    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "reader@example.com",
      password: "password",
    });
    expect(useAuthStore.getState()).toMatchObject({ user, profile, busy: false, error: null });
  });

  it("maps sign-in failures without leaving the store busy", async () => {
    const { client, signInWithPassword } = createClient();
    const failure = { code: "invalid_credentials" };
    signInWithPassword.mockResolvedValueOnce({ data: {}, error: failure });
    const { useAuthStore } = createJojoAuthStore(client);

    await expect(useAuthStore.getState().signIn("reader@example.com", "wrong")).rejects.toBe(failure);

    expect(useAuthStore.getState()).toMatchObject({
      busy: false,
      error: "邮箱或密码不正确。",
    });
  });
});
