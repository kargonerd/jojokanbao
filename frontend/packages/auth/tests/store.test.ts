import { describe, expect, it, vi } from "vitest";
import type { JojoAuthClient } from "../src/client";
import { createJojoAuthStore } from "../src/store";
import type { Profile } from "../src/types";

const profile: Profile = {
  id: "user-1",
  display_name: "雪豹-TGH",
  avatar_path: null,
  created_at: "2026-08-23T00:00:00Z",
  updated_at: "2026-08-23T00:00:00Z",
};

function createClient() {
  const user = { id: profile.id, email: "reader@example.com" };
  const session = { user, access_token: "access-token", refresh_token: "refresh-token" };
  const unsubscribe = vi.fn();
  const maybeSingle = vi.fn().mockResolvedValue({ data: profile, error: null });
  const signInWithPassword = vi.fn().mockResolvedValue({ data: { user, session }, error: null });
  const signUp = vi.fn().mockResolvedValue({ data: { user, session: null }, error: null });
  const verifyOtp = vi.fn().mockResolvedValue({ data: { user, session }, error: null });
  const resend = vi.fn().mockResolvedValue({ data: {}, error: null });
  const resetPasswordForEmail = vi.fn().mockResolvedValue({ data: {}, error: null });
  const updateUser = vi.fn().mockResolvedValue({ data: { user }, error: null });
  const signOut = vi.fn().mockResolvedValue({ error: null });
  const invoke = vi.fn().mockResolvedValue({ data: {}, error: null });
  const getSession = vi.fn().mockResolvedValue({ data: { session }, error: null });
  const onAuthStateChange = vi.fn().mockReturnValue({
    data: { subscription: { unsubscribe } },
  });

  const client = {
    auth: {
      signInWithPassword,
      signUp,
      verifyOtp,
      resend,
      resetPasswordForEmail,
      updateUser,
      signOut,
      getSession,
      onAuthStateChange,
    },
    functions: { invoke },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ maybeSingle, abortSignal: vi.fn() }),
      }),
    }),
  } as unknown as JojoAuthClient;

  return {
    client,
    user,
    session,
    unsubscribe,
    getSession,
    onAuthStateChange,
    maybeSingle,
    signInWithPassword,
    signUp,
    verifyOtp,
    resend,
    resetPasswordForEmail,
    updateUser,
    signOut,
    invoke,
  };
}

describe("createJojoAuthStore", () => {
  it.each(["qq.com@123456789", "mail.qq@9876543210", "reader@host.123", "reader@@qq.com"])(
    "rejects an incomplete or reversed signup email before requesting delivery: %s", async (email) => {
      const { client, signUp, resend } = createClient();
      const { useAuthStore } = createJojoAuthStore(client);
      await expect(useAuthStore.getState().signUp({ email, password: "password", invitationCode: "ABC123" })).rejects.toMatchObject({ code: "email_address_invalid" });
      expect(signUp).not.toHaveBeenCalled();
      expect(useAuthStore.getState()).toMatchObject({ busy: false, notice: null });
      expect(useAuthStore.getState().error).toContain("@ 前后的内容");
      await expect(useAuthStore.getState().resendSignUpCode(email)).rejects.toMatchObject({ code: "email_address_invalid" });
      expect(resend).not.toHaveBeenCalled();
    },
  );

  it.each(["reader@qq.com", "first.last+beta@custom.example.org", "reader@xn--fiqs8s.example"])(
    "allows complete email domains and trims whitespace: %s", async (email) => {
      const { client, signUp } = createClient();
      const { useAuthStore } = createJojoAuthStore(client);
      await useAuthStore.getState().signUp({ email: ` ${email} `, password: "password", invitationCode: "ABC123" });
      expect(signUp).toHaveBeenCalledWith(expect.objectContaining({ email }));
    },
  );

  it("keeps signup editable after a delivery failure", async () => {
    const { client, signUp } = createClient();
    const failure = { status: 500, code: "unexpected_failure", message: "Error sending confirmation email" };
    signUp.mockResolvedValueOnce({ data: { user: null, session: null }, error: failure });
    const { useAuthStore } = createJojoAuthStore(client);
    await expect(useAuthStore.getState().signUp({ email: "reader@example.com", password: "password", invitationCode: "ABC123" })).rejects.toEqual(failure);
    expect(useAuthStore.getState()).toMatchObject({ busy: false, user: null, notice: null });
    expect(useAuthStore.getState().error).toContain("请先检查邮箱地址");
  });
  it("allows retry after a stalled profile read, without clearing the session", async () => {
    vi.useFakeTimers();
    try {
      const { client, maybeSingle, user } = createClient();
      let resolveOld!: (value: { data: Profile; error: null }) => void;
      maybeSingle.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
      const { useAuthStore } = createJojoAuthStore(client);
      useAuthStore.setState({ user: user as never, initialized: true });
      const firstRead = useAuthStore.getState().refreshProfile();
      expect(useAuthStore.getState().profileStatus).toBe("loading");
      await vi.advanceTimersByTimeAsync(12_000);
      await firstRead;
      expect(useAuthStore.getState()).toMatchObject({ user, profile: null, profileStatus: "error" });
      await useAuthStore.getState().refreshProfile();
      expect(useAuthStore.getState()).toMatchObject({ profile, profileStatus: "ready" });
      expect(maybeSingle).toHaveBeenCalledTimes(2);
      resolveOld({ data: { ...profile, display_name: "旧代号-ABC" }, error: null });
      await vi.advanceTimersByTimeAsync(0);
      expect(useAuthStore.getState().profile).toEqual(profile);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not attach a pending profile refresh to a different account", async () => {
    const { client, maybeSingle, user } = createClient();
    let resolveRead!: (value: { data: Profile; error: null }) => void;
    maybeSingle.mockReturnValueOnce(new Promise((resolve) => { resolveRead = resolve; }));
    const { useAuthStore } = createJojoAuthStore(client);
    useAuthStore.setState({ user: user as never, initialized: true });
    const reading = useAuthStore.getState().refreshProfile();
    useAuthStore.setState({ user: { ...user, id: "user-2" } as never, profileStatus: "idle" });
    resolveRead({ data: profile, error: null });
    await reading;
    expect(useAuthStore.getState()).toMatchObject({ user: { id: "user-2" }, profile: null, profileStatus: "idle" });
  });

  it("keeps a previously loaded profile when a refresh fails", async () => {
    const { client, maybeSingle, user } = createClient();
    maybeSingle.mockResolvedValueOnce({ data: null, error: new Error("offline") });
    const { useAuthStore } = createJojoAuthStore(client);
    useAuthStore.setState({ user: user as never, profile });
    await useAuthStore.getState().refreshProfile();
    expect(useAuthStore.getState()).toMatchObject({ profile, profileStatus: "error" });
  });

  it("restores identity before profile hydration and coalesces the initial profile read", async () => {
    let resolveProfile!: (value: { data: Profile; error: null }) => void;
    const delayedProfile = new Promise<{ data: Profile; error: null }>((resolve) => {
      resolveProfile = resolve;
    });
    const { client, getSession, onAuthStateChange, maybeSingle, session, unsubscribe, user } = createClient();
    maybeSingle.mockReturnValueOnce(delayedProfile);
    const controller = createJojoAuthStore(client);
    const stop = controller.startAuthSync();

    await vi.waitFor(() => expect(controller.useAuthStore.getState().initialized).toBe(true));
    expect(getSession).toHaveBeenCalledOnce();
    expect(controller.useAuthStore.getState()).toMatchObject({ user, profile: null });

    const initialSession = onAuthStateChange.mock.calls[0]?.[0] as ((event: string, value: typeof session) => void);
    initialSession("INITIAL_SESSION", session);
    expect(maybeSingle).toHaveBeenCalledOnce();

    resolveProfile({ data: profile, error: null });
    await vi.waitFor(() => expect(controller.useAuthStore.getState().profile).toEqual(profile));
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("shares one underlying auth subscription between multiple consumers", async () => {
    const { client, getSession, onAuthStateChange, unsubscribe } = createClient();
    const controller = createJojoAuthStore(client);
    const stopFirst = controller.startAuthSync();
    const stopSecond = controller.startAuthSync();

    await vi.waitFor(() => expect(getSession).toHaveBeenCalledOnce());
    expect(onAuthStateChange).toHaveBeenCalledOnce();
    stopFirst();
    expect(unsubscribe).not.toHaveBeenCalled();
    stopSecond();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("signs in and maps invalid credentials", async () => {
    const { client, signInWithPassword, user } = createClient();
    const { useAuthStore } = createJojoAuthStore(client);
    await useAuthStore.getState().signIn("reader@example.com", "password");
    expect(useAuthStore.getState()).toMatchObject({ user, profile, busy: false });

    const failure = { code: "invalid_credentials" };
    signInWithPassword.mockResolvedValueOnce({ data: {}, error: failure });
    await expect(useAuthStore.getState().signIn("reader@example.com", "wrong")).rejects.toBe(failure);
    expect(useAuthStore.getState().error).toBe("邮箱或密码不正确。");
  });

  it("keeps an unconfirmed signup signed out and confirms its email code", async () => {
    const { client, signUp, verifyOtp, user } = createClient();
    const { useAuthStore } = createJojoAuthStore(client);

    const needsCode = await useAuthStore.getState().signUp({
      email: "reader@example.com",
      password: "strong-password",
      invitationCode: " A2BC9Z ",
    });
    expect(signUp).toHaveBeenCalledWith({
      email: "reader@example.com",
      password: "strong-password",
      options: { data: { invitation_code: "A2BC9Z" } },
    });
    expect(needsCode).toBe(true);
    expect(useAuthStore.getState().user).toBeNull();

    await useAuthStore.getState().confirmSignUp("reader@example.com", " 123456 ");
    expect(verifyOtp).toHaveBeenCalledWith({
      email: "reader@example.com",
      token: "123456",
      type: "email",
    });
    expect(useAuthStore.getState()).toMatchObject({ user, profile, busy: false });
  });

  it("resends signup codes and starts recovery without exposing account existence", async () => {
    const { client, resend, resetPasswordForEmail } = createClient();
    const { useAuthStore } = createJojoAuthStore(client);
    await useAuthStore.getState().resendSignUpCode(" reader@example.com ");
    expect(resend).toHaveBeenCalledWith({ type: "signup", email: "reader@example.com" });
    await useAuthStore.getState().sendPasswordReset(" reader@example.com ");
    expect(resetPasswordForEmail).toHaveBeenCalledWith("reader@example.com");
    expect(useAuthStore.getState().notice).toContain("如果该邮箱已注册");
  });

  it("verifies a recovery code, updates the password, and signs out other sessions", async () => {
    const { client, verifyOtp, updateUser, signOut } = createClient();
    const { useAuthStore } = createJojoAuthStore(client);
    await useAuthStore.getState().verifyPasswordResetCode("reader@example.com", "654321");
    expect(verifyOtp).toHaveBeenCalledWith({
      email: "reader@example.com",
      token: "654321",
      type: "recovery",
    });
    expect(useAuthStore.getState().recoveryPending).toBe(true);
    await useAuthStore.getState().completePasswordRecovery("new-strong-password");
    expect(updateUser).toHaveBeenCalledWith({ password: "new-strong-password" });
    expect(signOut).toHaveBeenCalledWith({ scope: "others" });
    expect(useAuthStore.getState().recoveryPending).toBe(false);
  });

  it("reauthenticates before changing a password or deleting the account", async () => {
    const { client, user, session, signInWithPassword, updateUser, invoke, signOut } = createClient();
    const { useAuthStore } = createJojoAuthStore(client);
    useAuthStore.setState({ user: user as never, session: session as never, profile });
    await useAuthStore.getState().changePassword("current-password", "new-strong-password");
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "reader@example.com",
      password: "current-password",
    });
    expect(updateUser).toHaveBeenCalledWith({ password: "new-strong-password" });

    await useAuthStore.getState().deleteAccount("new-strong-password");
    expect(invoke).toHaveBeenCalledWith("delete-account", { method: "POST" });
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(useAuthStore.getState()).toMatchObject({ user: null, session: null, profile: null });
  });
});
