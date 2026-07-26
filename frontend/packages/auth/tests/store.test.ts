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
  const signUp = vi.fn().mockResolvedValue({
    data: { user, session: null },
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
      signUp,
    },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ maybeSingle }),
      }),
    }),
  } as unknown as JojoAuthClient;

  return { client, getSession, signInWithPassword, signUp, unsubscribe, user, session };
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

  it("signs up with invitation metadata and keeps unconfirmed users signed out", async () => {
    const { client, signUp } = createClient();
    const { useAuthStore } = createJojoAuthStore(client);

    const requiresConfirmation = await useAuthStore.getState().signUp({
      email: "reader@example.com",
      password: "strong-password",
      invitationCode: " JOJO-ABCD-EFGH-IJKL ",
      emailRedirectTo: "https://reader.jojokanbao.cn/account",
    });

    expect(signUp).toHaveBeenCalledWith({
      email: "reader@example.com",
      password: "strong-password",
      options: {
        emailRedirectTo: "https://reader.jojokanbao.cn/account",
        data: { invitation_code: "JOJO-ABCD-EFGH-IJKL" },
      },
    });
    expect(requiresConfirmation).toBe(true);
    expect(useAuthStore.getState()).toMatchObject({
      session: null,
      user: null,
      busy: false,
      notice: "确认邮件已经发出，请打开邮件完成注册。",
    });
  });

  it("keeps the session when email confirmation is disabled", async () => {
    const { client, signUp, session, user } = createClient();
    signUp.mockResolvedValueOnce({ data: { user, session }, error: null });
    const { useAuthStore } = createJojoAuthStore(client);

    const requiresConfirmation = await useAuthStore.getState().signUp({
      email: "reader@example.com",
      password: "strong-password",
      invitationCode: "JOJO-ABCD-EFGH-IJKL",
      emailRedirectTo: "https://reader.jojokanbao.cn/account",
    });

    expect(requiresConfirmation).toBe(false);
    expect(useAuthStore.getState()).toMatchObject({ session, user, busy: false });
  });
});
