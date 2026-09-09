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
    createRecoveryClient: vi.fn(() => ({ auth: { setSession: vi.fn().mockResolvedValue({ error: null }), updateUser, signOut, dispose: vi.fn().mockResolvedValue(undefined) } })),
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
  it.each([undefined, "", "   "])("registers without invitation metadata when no code is supplied: %s", async (invitationCode) => {
    const { client, signUp } = createClient();
    const { useAuthStore } = createJojoAuthStore(client);
    expect(await useAuthStore.getState().signUp({ email: "reader@example.com", password: "password", invitationCode })).toBe(true);
    expect(signUp).toHaveBeenCalledWith({ email: "reader@example.com", password: "password" });
  });

  it("reads open signup, restores invitations, and falls back safely for an older server", async () => {
    const { client } = createClient();
    const abortSignal = vi.fn()
      .mockResolvedValueOnce({ data: false, error: null })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202" } });
    const rpc = vi.fn(() => ({ abortSignal }));
    client.rpc = rpc as unknown as JojoAuthClient["rpc"];
    const { useAuthStore } = createJojoAuthStore(client);
    await useAuthStore.getState().refreshSignupPolicy();
    expect(rpc).toHaveBeenCalledWith("signup_invitation_required");
    expect(useAuthStore.getState().signupInvitationRequired).toBe(false);
    await useAuthStore.getState().refreshSignupPolicy();
    expect(useAuthStore.getState().signupInvitationRequired).toBe(true);
    useAuthStore.setState({ signupInvitationRequired: false });
    await useAuthStore.getState().refreshSignupPolicy();
    expect(useAuthStore.getState().signupInvitationRequired).toBe(true);
  });

  it("ignores a stale open-signup response after invitations have been restored", async () => {
    const { client } = createClient();
    let resolveOld!: (value: unknown) => void;
    const abortSignal = vi.fn()
      .mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ data: true, error: null });
    client.rpc = vi.fn(() => ({ abortSignal })) as unknown as JojoAuthClient["rpc"];
    const { useAuthStore } = createJojoAuthStore(client);
    const oldRequest = useAuthStore.getState().refreshSignupPolicy();
    await useAuthStore.getState().refreshSignupPolicy();
    resolveOld({ data: false, error: null });
    await oldRequest;
    expect(useAuthStore.getState().signupInvitationRequired).toBe(true);
  });
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

  it("restores native identity while refresh is stalled and keeps it through an offline INITIAL_SESSION", async () => {
    const { client, getSession, onAuthStateChange, session, user } = createClient();
    getSession.mockReturnValue(new Promise(() => undefined));
    const readPersistedSession = vi.fn().mockResolvedValue(session);
    const controller = createJojoAuthStore(client, { readPersistedSession });
    const stop = controller.startAuthSync();
    await vi.waitFor(() => expect(controller.useAuthStore.getState()).toMatchObject({ user, initialized: true }));
    onAuthStateChange.mock.calls[0]![0]("INITIAL_SESSION", null);
    await vi.waitFor(() => expect(readPersistedSession).toHaveBeenCalledTimes(2));
    expect(controller.useAuthStore.getState().user).toEqual(user);
    const refreshed = { ...session, access_token: "refreshed" };
    onAuthStateChange.mock.calls[0]![0]("TOKEN_REFRESHED", refreshed);
    expect(controller.useAuthStore.getState().session?.access_token).toBe("refreshed");
    onAuthStateChange.mock.calls[0]![0]("SIGNED_OUT", null);
    expect(controller.useAuthStore.getState().user).toBeNull();
    stop();
  });

  it.each(["SIGNED_OUT", "SIGNED_IN", "stop"])("ignores a delayed native cache read after %s", async (event) => {
    const { client, getSession, onAuthStateChange, session } = createClient();
    getSession.mockReturnValue(new Promise(() => undefined));
    let finish!: (value: typeof session) => void;
    const controller = createJojoAuthStore(client, {
      readPersistedSession: () => new Promise((resolve) => { finish = resolve as typeof finish; }),
    });
    const stop = controller.startAuthSync();
    const other = { ...session, user: { ...session.user, id: "other" } };
    if (event === "stop") stop();
    else onAuthStateChange.mock.calls[0]![0](event, event === "SIGNED_OUT" ? null : other);
    finish(session);
    await Promise.resolve();
    expect(controller.useAuthStore.getState().user?.id ?? null).toBe(event === "SIGNED_IN" ? "other" : null);
    stop();
  });

  it("lets a successful session check override an expired native cache", async () => {
    const { client, getSession, session } = createClient();
    let finish!: (value: unknown) => void;
    getSession.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const controller = createJojoAuthStore(client, { readPersistedSession: vi.fn().mockResolvedValue(session) });
    const stop = controller.startAuthSync();
    await vi.waitFor(() => expect(controller.useAuthStore.getState().user?.id).toBe(session.user.id));
    finish({ data: { session: null }, error: null });
    await vi.waitFor(() => expect(controller.useAuthStore.getState().user).toBeNull());
    stop();
  });

  it("handles a rejected session check without clearing cached identity", async () => {
    const { client, getSession, session } = createClient();
    getSession.mockRejectedValueOnce(new Error("Failed to fetch"));
    const controller = createJojoAuthStore(client, { readPersistedSession: vi.fn().mockResolvedValue(session) });
    const stop = controller.startAuthSync();
    await vi.waitFor(() => expect(controller.useAuthStore.getState()).toMatchObject({ initialized: true, user: session.user }));
    stop();
  });

  it("does not overwrite an explicitly verified session with a late bootstrap read", async () => {
    const { client, getSession, session } = createClient();
    let finish!: (value: unknown) => void;
    getSession.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const controller = createJojoAuthStore(client, { readPersistedSession: vi.fn().mockResolvedValue(session) });
    const stop = controller.startAuthSync();
    await vi.waitFor(() => expect(controller.useAuthStore.getState().user).toEqual(session.user));
    await controller.useAuthStore.getState().verifyPasswordResetCode("reader@example.com", "123456");
    finish({ data: { session: null }, error: null });
    await Promise.resolve();
    expect(controller.useAuthStore.getState()).toMatchObject({ user: session.user, recoveryPending: true });
    stop();
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

  it.each([false, true])("keeps a failed recovery unverified with an existing session: %s", async (signedIn) => {
    const fixture = createClient();
    const { useAuthStore } = createJojoAuthStore(fixture.client);
    if (signedIn) await useAuthStore.getState().signIn(fixture.user.email, "password");
    let finishVerification!: (result: unknown) => void;
    fixture.verifyOtp.mockReturnValueOnce(new Promise((resolve) => { finishVerification = resolve; }));
    const verification = useAuthStore.getState().verifyPasswordResetCode("other@example.com", "000000");
    const rejected = expect(verification).rejects.toMatchObject({ code: "otp_expired" });
    expect(useAuthStore.getState()).toMatchObject({ recoveryPending: false, recoveryEmail: "other@example.com", busy: true });
    finishVerification({ data: { user: null, session: null }, error: { code: "otp_expired" } });
    await rejected;
    expect(useAuthStore.getState()).toMatchObject({ recoveryPending: false, busy: false, user: signedIn ? fixture.user : null });
    await expect(useAuthStore.getState().completePasswordRecovery("new-password")).rejects.toMatchObject({ code: "password_recovery_required" });
    expect(fixture.updateUser).not.toHaveBeenCalled();

    const otherUser = { ...fixture.user, id: "user-2", email: "other@example.com" };
    const otherSession = { ...fixture.session, user: otherUser, access_token: "other-token" };
    fixture.verifyOtp.mockResolvedValueOnce({ data: { user: otherUser, session: otherSession }, error: null });
    fixture.getSession.mockResolvedValue({ data: { session: otherSession }, error: null });
    await useAuthStore.getState().verifyPasswordResetCode(otherUser.email, "123456");
    expect(useAuthStore.getState()).toMatchObject({ user: otherUser, recoveryPending: true, recoveryEmail: otherUser.email });
    await useAuthStore.getState().completePasswordRecovery("new-password");
    expect(fixture.updateUser).toHaveBeenCalledOnce();
  });

  it("rejects a successful OTP response for a different email", async () => {
    const { client, updateUser } = createClient();
    const { useAuthStore } = createJojoAuthStore(client);
    await expect(useAuthStore.getState().verifyPasswordResetCode("other@example.com", "123456")).rejects.toMatchObject({ code: "password_recovery_required" });
    await expect(useAuthStore.getState().completePasswordRecovery("new-password")).rejects.toMatchObject({ code: "password_recovery_required" });
    expect(updateUser).not.toHaveBeenCalled();
  });

  it.each(["cancel", "new-email", "sign-in", "session-switch"])("invalidates an earlier recovery on %s", async (transition) => {
    const { client, getSession, session, updateUser } = createClient();
    const { useAuthStore } = createJojoAuthStore(client);
    await useAuthStore.getState().verifyPasswordResetCode("reader@example.com", "654321");
    if (transition === "cancel") useAuthStore.getState().cancelPasswordRecovery();
    if (transition === "new-email") await useAuthStore.getState().sendPasswordReset("other@example.com");
    if (transition === "sign-in") await useAuthStore.getState().signIn("reader@example.com", "password");
    // Detect a changed SDK session even before its auth callback reaches the store.
    if (transition === "session-switch") getSession.mockResolvedValue({ data: { session: { ...session, access_token: "new-login-token" } }, error: null });
    await expect(useAuthStore.getState().completePasswordRecovery("new-password")).rejects.toMatchObject({ code: "password_recovery_required" });
    expect(updateUser).not.toHaveBeenCalled();
    expect(useAuthStore.getState().recoveryPending).toBe(false);
  });

  it("does not restore a recovery that was cancelled while OTP verification was in flight", async () => {
    const { client, verifyOtp, user, session } = createClient();
    let finishVerification!: (result: unknown) => void;
    verifyOtp.mockReturnValueOnce(new Promise((resolve) => { finishVerification = resolve; }));
    const { useAuthStore } = createJojoAuthStore(client);
    const verification = useAuthStore.getState().verifyPasswordResetCode(user.email, "123456");
    const rejected = expect(verification).rejects.toMatchObject({ code: "password_recovery_required" });
    useAuthStore.getState().cancelPasswordRecovery();
    finishVerification({ data: { user, session }, error: null });
    await rejected;
    expect(useAuthStore.getState()).toMatchObject({ recoveryEmail: null, recoveryPending: false, busy: false, error: null });
  });

  it("retains verified recovery on token refresh, but clears it on sign-out", async () => {
    const { client, session, getSession, onAuthStateChange, updateUser } = createClient();
    const controller = createJojoAuthStore(client);
    const stop = controller.startAuthSync();
    await vi.waitFor(() => expect(controller.useAuthStore.getState().initialized).toBe(true));
    await controller.useAuthStore.getState().verifyPasswordResetCode("reader@example.com", "123456");
    const authEvent = onAuthStateChange.mock.calls[0]![0];
    const refreshed = { ...session, access_token: "refreshed-token" };
    getSession.mockResolvedValue({ data: { session: refreshed }, error: null });
    authEvent("TOKEN_REFRESHED", refreshed);
    await controller.useAuthStore.getState().completePasswordRecovery("new-password");
    expect(updateUser).toHaveBeenCalledOnce();
    await controller.useAuthStore.getState().sendPasswordReset("reader@example.com");
    authEvent("SIGNED_OUT", null);
    expect(controller.useAuthStore.getState()).toMatchObject({ recoveryEmail: null, recoveryPending: false });
    stop();
  });

  it("does not let an older initial session overwrite a recovery auth callback", async () => {
    const { client, getSession, onAuthStateChange, session } = createClient();
    let finishInitial!: (result: unknown) => void;
    getSession.mockReturnValueOnce(new Promise((resolve) => { finishInitial = resolve; }));
    const controller = createJojoAuthStore(client);
    const stop = controller.startAuthSync();
    const recoveredSession = { ...session, user: { ...session.user, id: "user-2", email: "other@example.com" } };
    onAuthStateChange.mock.calls[0]![0]("PASSWORD_RECOVERY", recoveredSession);
    finishInitial({ data: { session }, error: null });
    await Promise.resolve();
    expect(controller.useAuthStore.getState().user).toEqual(recoveredSession.user);
    expect(controller.useAuthStore.getState().recoveryPending).toBe(false);
    stop();
  });

  it("invalidates an in-flight OTP when another tab signs in", async () => {
    const { client, verifyOtp, user, session, getSession, onAuthStateChange } = createClient();
    let finishVerification!: (result: unknown) => void;
    verifyOtp.mockReturnValueOnce(new Promise((resolve) => { finishVerification = resolve; }));
    const controller = createJojoAuthStore(client);
    const stop = controller.startAuthSync();
    await vi.waitFor(() => expect(controller.useAuthStore.getState().initialized).toBe(true));
    const verification = controller.useAuthStore.getState().verifyPasswordResetCode(user.email, "123456");
    const rejected = expect(verification).rejects.toMatchObject({ code: "password_recovery_required" });
    onAuthStateChange.mock.calls[0]![0]("SIGNED_IN", { ...session, access_token: "another-login-token" });
    // The late SDK callback/response must not resurrect the cancelled form.
    onAuthStateChange.mock.calls[0]![0]("PASSWORD_RECOVERY", session);
    getSession.mockResolvedValue({ data: { session }, error: null });
    finishVerification({ data: { user, session }, error: null });
    await rejected;
    expect(controller.useAuthStore.getState()).toMatchObject({ recoveryEmail: null, recoveryPending: false, busy: false });
    stop();
  });

  it.each(["session", "update", "logout"])("does not continue or show success after cancellation during %s", async (stage) => {
    const { client } = createClient();
    const setSession = vi.fn().mockResolvedValue({ error: null });
    const updateUser = vi.fn().mockResolvedValue({ error: null });
    const signOut = vi.fn().mockResolvedValue({ error: null });
    const dispose = vi.fn().mockResolvedValue(undefined);
    let finish!: (value: { error: null }) => void;
    const delayed = stage === "session" ? setSession : stage === "update" ? updateUser : signOut;
    delayed.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    vi.mocked(client.createRecoveryClient).mockReturnValue({ auth: { setSession, updateUser, signOut, dispose } } as never);
    const { useAuthStore } = createJojoAuthStore(client);
    await useAuthStore.getState().verifyPasswordResetCode("reader@example.com", "123456");
    const saving = useAuthStore.getState().completePasswordRecovery("new-password");
    const rejected = expect(saving).rejects.toMatchObject({ code: "password_recovery_required" });
    await vi.waitFor(() => expect(delayed).toHaveBeenCalledOnce());
    useAuthStore.getState().cancelPasswordRecovery();
    finish({ error: null });
    await rejected;
    if (stage === "session") expect(updateUser).not.toHaveBeenCalled();
    if (stage !== "logout") expect(signOut).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({ recoveryPending: false, busy: false, notice: null });
    expect(dispose).toHaveBeenCalledOnce();
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
