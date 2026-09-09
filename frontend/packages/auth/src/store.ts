import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { JojoAuthClient } from "./client";
import { getAuthErrorMessage } from "./errors";
import { validateRegistrationEmail } from "./email";
import { createProfileRepository } from "./profile";
import type { AuthState, SignUpInput } from "./types";

export interface AuthActions {
  refreshSignupPolicy: () => Promise<void>;
  clearFeedback: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: SignUpInput) => Promise<boolean>;
  confirmSignUp: (email: string, code: string) => Promise<void>;
  resendSignUpCode: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
  cancelPasswordRecovery: () => void;
  verifyPasswordResetCode: (email: string, code: string) => Promise<void>;
  completePasswordRecovery: (password: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  deleteAccount: (currentPassword: string) => Promise<void>;
  refreshProfile: () => Promise<void>;
}

export type AuthStore = AuthState & AuthActions;
export type JojoAuthStore = UseBoundStore<StoreApi<AuthStore>>;

export interface JojoAuthController {
  useAuthStore: JojoAuthStore;
  startAuthSync: () => () => void;
}

export function createJojoAuthStore(client: JojoAuthClient): JojoAuthController {
  const profiles = createProfileRepository(client);
  const pendingProfiles = new Map<string, ReturnType<typeof profiles.getOrCreate>>();
  let recoveryRevision = 0;
  let signupPolicyRequest: AbortController | undefined;
  // This guards the application's recovery flow; Supabase still enforces its
  // own password-update authorization policy independently.
  let verifiedRecovery: { userId: string; accessToken: string } | null = null;
  const invalidateRecovery = () => {
    verifiedRecovery = null;
    return ++recoveryRevision;
  };
  const recoveryRequired = () => ({ code: "password_recovery_required" });

  const loadProfile = (userId: string) => {
    const pending = pendingProfiles.get(userId);
    if (pending) return pending;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject({ code: "profile_request_timeout" });
        abort.abort();
      }, 12_000);
    });
    // Bound hydration even if the network or token refresh never settles, so a
    // later foreground/manual retry is not trapped behind a stale promise.
    const promise = Promise.race([profiles.getOrCreate(userId, abort.signal), timeout])
      .finally(() => clearTimeout(timer));
    pendingProfiles.set(userId, promise);
    void promise.then(
      () => { if (pendingProfiles.get(userId) === promise) pendingProfiles.delete(userId); },
      () => { if (pendingProfiles.get(userId) === promise) pendingProfiles.delete(userId); },
    );
    return promise;
  };

  const useAuthStore = create<AuthStore>((set, get) => ({
    signupInvitationRequired: true,
    session: null,
    user: null,
    profile: null,
    profileStatus: "idle",
    recoveryEmail: null,
    recoveryPending: false,
    initialized: false,
    busy: false,
    error: null,
    notice: null,

    refreshSignupPolicy: async () => {
      signupPolicyRequest?.abort();
      const request = new AbortController();
      signupPolicyRequest = request;
      const timer = setTimeout(() => request.abort(), 10_000);
      try {
        const { data, error } = await client.rpc("signup_invitation_required").abortSignal(request.signal);
        if (error) throw error;
        if (signupPolicyRequest === request) set({ signupInvitationRequired: data !== false });
      } catch {
        // Older deployments and unavailable configuration retain invitation signup.
        if (signupPolicyRequest === request) set({ signupInvitationRequired: true });
      } finally {
        clearTimeout(timer);
      }
    },

    clearFeedback: () => set({ error: null, notice: null }),

    cancelPasswordRecovery: () => {
      invalidateRecovery();
      set({ recoveryEmail: null, recoveryPending: false, busy: false });
    },

    signIn: async (email, password) => {
      get().cancelPasswordRecovery();
      set({ busy: true, error: null, notice: null });
      try {
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw error;
        const profile = data.user ? await loadProfile(data.user.id) : null;
        set({ session: data.session, user: data.user, profile, profileStatus: profile ? "ready" : "idle", busy: false });
      } catch (error) {
        set({ busy: false, error: getAuthErrorMessage(error) });
        throw error;
      }
    },

    signUp: async ({ email, password, invitationCode }) => {
      get().cancelPasswordRecovery();
      set({ busy: true, error: null, notice: null });
      try {
        const { data, error } = await client.auth.signUp({
          email: validateRegistrationEmail(email),
          password,
          ...(invitationCode?.trim() ? {
            options: { data: { invitation_code: invitationCode.trim() } },
          } : {}),
        });
        if (error) throw error;

        const session = data.session;
        const requiresEmailConfirmation = session === null;
        set({
          session,
          user: session?.user ?? null,
          busy: false,
          notice: requiresEmailConfirmation
            ? "验证码已经发送，请在当前页面完成注册。"
            : "账号已经创建。",
        });
        return requiresEmailConfirmation;
      } catch (error) {
        set({ busy: false, error: getAuthErrorMessage(error) });
        throw error;
      }
    },

    confirmSignUp: async (email, code) => {
      get().cancelPasswordRecovery();
      set({ busy: true, error: null, notice: null });
      try {
        const { data, error } = await client.auth.verifyOtp({
          email: email.trim(),
          token: code.trim(),
          type: "email",
        });
        if (error) throw error;
        const profile = data.user ? await loadProfile(data.user.id) : null;
        set({
          session: data.session,
          user: data.user,
          profile,
          profileStatus: profile ? "ready" : "idle",
          recoveryPending: false,
          busy: false,
          notice: "邮箱验证完成，账号已经启用。",
        });
      } catch (error) {
        set({ busy: false, error: getAuthErrorMessage(error) });
        throw error;
      }
    },

    resendSignUpCode: async (email) => {
      set({ busy: true, error: null, notice: null });
      try {
        const { error } = await client.auth.resend({
          type: "signup",
          email: validateRegistrationEmail(email),
        });
        if (error) throw error;
        set({ busy: false, notice: "新的验证码已经发送。" });
      } catch (error) {
        set({ busy: false, error: getAuthErrorMessage(error) });
        throw error;
      }
    },

    signOut: async () => {
      get().cancelPasswordRecovery();
      set({ busy: true, error: null, notice: null });
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) {
        set({ busy: false, error: getAuthErrorMessage(error) });
        throw error;
      }
      set({ session: null, user: null, profile: null, profileStatus: "idle", recoveryPending: false, busy: false });
    },

    sendPasswordReset: async (email) => {
      const revision = invalidateRecovery();
      set({ busy: true, recoveryPending: false, recoveryEmail: null, error: null, notice: null });
      try {
        const { error } = await client.auth.resetPasswordForEmail(email.trim());
        if (error) throw error;
        if (revision !== recoveryRevision) throw recoveryRequired();
        set({ busy: false, recoveryEmail: email.trim(), notice: "如果该邮箱已注册，你会收到一封重置密码邮件。" });
      } catch (error) {
        if (revision === recoveryRevision) set({ busy: false, error: getAuthErrorMessage(error) });
        throw error;
      }
    },

    verifyPasswordResetCode: async (email, code) => {
      const revision = invalidateRecovery();
      // Keep the recovery route through auth callbacks/remounts, without
      // treating an in-flight request as permission to show the password form.
      set({ busy: true, recoveryEmail: email.trim(), recoveryPending: false, error: null, notice: null });
      try {
        const { data, error } = await client.auth.verifyOtp({
          email: email.trim(),
          token: code.trim(),
          type: "recovery",
        });
        if (error) throw error;
        const session = data.session;
        if (!session || !data.user || session.user.id !== data.user.id
          || session.user.email?.toLowerCase() !== email.trim().toLowerCase()) throw recoveryRequired();
        const current = await client.auth.getSession();
        if (current.error) throw current.error;
        if (revision !== recoveryRevision || current.data.session?.access_token !== session.access_token) throw recoveryRequired();
        verifiedRecovery = { userId: session.user.id, accessToken: session.access_token };
        syncSession(session);
        set({
          recoveryPending: true,
          busy: false,
          notice: "验证码正确，请设置新密码。",
        });
      } catch (error) {
        if (revision === recoveryRevision) {
          verifiedRecovery = null;
          set({ busy: false, recoveryPending: false, error: getAuthErrorMessage(error) });
        }
        throw error;
      }
    },

    completePasswordRecovery: async (password) => {
      const revision = recoveryRevision;
      let recoveryClient: ReturnType<JojoAuthClient["createRecoveryClient"]> | undefined;
      set({ busy: true, error: null, notice: null });
      try {
        const recovery = verifiedRecovery;
        const current = await client.auth.getSession();
        if (current.error) throw current.error;
        if (revision !== recoveryRevision) throw recoveryRequired();
        if (!recovery || recovery !== verifiedRecovery || !get().recoveryPending
          || get().user?.id !== recovery.userId
          || current.data.session?.user.id !== recovery.userId
          || current.data.session.access_token !== recovery.accessToken) {
          verifiedRecovery = null;
          set({ recoveryPending: false });
          throw recoveryRequired();
        }
        recoveryClient = client.createRecoveryClient();
        const { error: sessionError } = await recoveryClient.auth.setSession(current.data.session);
        if (sessionError) throw sessionError;
        if (revision !== recoveryRevision || recovery !== verifiedRecovery) throw recoveryRequired();
        const { error } = await recoveryClient.auth.updateUser({ password });
        if (error) throw error;
        if (revision !== recoveryRevision || recovery !== verifiedRecovery) throw recoveryRequired();
        const { error: signOutError } = await recoveryClient.auth.signOut({ scope: "others" });
        if (signOutError) throw signOutError;
        if (revision !== recoveryRevision || recovery !== verifiedRecovery) throw recoveryRequired();
        invalidateRecovery();
        set({ recoveryEmail: null, recoveryPending: false, busy: false, notice: "密码已更新，其他设备的登录已经退出。" });
      } catch (error) {
        if (revision === recoveryRevision) set({ busy: false, error: getAuthErrorMessage(error) });
        throw error;
      } finally {
        await recoveryClient?.auth.dispose();
      }
    },

    changePassword: async (currentPassword, newPassword) => {
      get().cancelPasswordRecovery();
      const email = get().user?.email;
      if (!email) throw new Error("Not authenticated");
      set({ busy: true, error: null, notice: null });
      try {
        const { data, error: signInError } = await client.auth.signInWithPassword({
          email,
          password: currentPassword,
        });
        if (signInError) throw signInError;
        const { error } = await client.auth.updateUser({ password: newPassword });
        if (error) throw error;
        const { error: signOutError } = await client.auth.signOut({ scope: "others" });
        if (signOutError) throw signOutError;
        set({ session: data.session, user: data.user, busy: false, notice: "密码已经修改。" });
      } catch (error) {
        set({ busy: false, error: getAuthErrorMessage(error) });
        throw error;
      }
    },

    deleteAccount: async (currentPassword) => {
      get().cancelPasswordRecovery();
      const email = get().user?.email;
      if (!email) throw new Error("Not authenticated");
      set({ busy: true, error: null, notice: null });
      try {
        const { error: signInError } = await client.auth.signInWithPassword({
          email,
          password: currentPassword,
        });
        if (signInError) throw signInError;
        const { error } = await client.functions.invoke("delete-account", { method: "POST" });
        if (error) throw error;
        await client.auth.signOut({ scope: "local" }).catch(() => undefined);
        set({
          session: null,
          user: null,
          profile: null,
          profileStatus: "idle",
          recoveryPending: false,
          busy: false,
          notice: "账号已经注销。",
        });
      } catch (error) {
        set({ busy: false, error: getAuthErrorMessage(error) });
        throw error;
      }
    },

    refreshProfile: async () => {
      const user = get().user;
      if (!user) return;
      const revision = sessionRevision;
      set({ profileStatus: "loading" });
      try {
        const profile = await loadProfile(user.id);
        if (revision !== sessionRevision || get().user?.id !== user.id) return;
        set({ profile, profileStatus: "ready", error: null });
      } catch (error) {
        if (revision !== sessionRevision || get().user?.id !== user.id) return;
        set({ profileStatus: "error", error: getAuthErrorMessage(error) });
      }
    },

  }));

  let sessionRevision = 0;

  const syncSession = (session: Session | null, event?: AuthChangeEvent) => {
    const revision = ++sessionRevision;
    const current = useAuthStore.getState();
    if (event === "SIGNED_IN" && current.recoveryEmail && session?.access_token !== current.session?.access_token) {
      current.cancelPasswordRecovery();
    }
    if (verifiedRecovery && (session?.user.id !== verifiedRecovery.userId
      || (session.access_token !== verifiedRecovery.accessToken && event !== "TOKEN_REFRESHED"))) {
      invalidateRecovery();
      useAuthStore.setState({ recoveryPending: false, busy: false, error: getAuthErrorMessage(recoveryRequired()) });
    } else if (verifiedRecovery && session && event === "TOKEN_REFRESHED") {
      verifiedRecovery.accessToken = session.access_token;
    }
    if (event === "SIGNED_OUT") useAuthStore.getState().cancelPasswordRecovery();
    if (!session?.user) {
      useAuthStore.setState({
        session: null,
        user: null,
        profile: null,
        profileStatus: "idle",
        recoveryPending: false,
        initialized: true,
      });
      return;
    }
    const userId = session.user.id;
    const profile = current.user?.id === userId ? current.profile : null;

    // The persisted session is enough to establish identity. Profile hydration
    // is cosmetic and must not hold the whole application in an unknown state.
    useAuthStore.setState({ session, user: session.user, profile, profileStatus: profile ? "ready" : "loading", initialized: true });
    if (profile) return;

    void loadProfile(userId).then((nextProfile) => {
      if (revision !== sessionRevision || useAuthStore.getState().user?.id !== userId) return;
      useAuthStore.setState({ profile: nextProfile, profileStatus: "ready", error: null });
    }).catch((error) => {
      if (revision !== sessionRevision || useAuthStore.getState().user?.id !== userId) return;
      useAuthStore.setState({ profileStatus: "error", error: getAuthErrorMessage(error) });
    });
  };

  let syncConsumers = 0;
  let stopSharedSync: (() => void) | undefined;

  const startAuthSync = () => {
    syncConsumers += 1;
    if (!stopSharedSync) {
      let active = true;
      const initialRevision = sessionRevision;
      void client.auth.getSession().then(({ data, error }) => {
        if (!active || initialRevision !== sessionRevision) return;
        if (error) {
          useAuthStore.setState({ initialized: true, error: getAuthErrorMessage(error) });
          return;
        }
        syncSession(data.session);
      });

      const { data } = client.auth.onAuthStateChange((event, session) => {
        if (active) syncSession(session, event);
      });
      stopSharedSync = () => {
        active = false;
        data.subscription.unsubscribe();
      };
    }

    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      syncConsumers = Math.max(0, syncConsumers - 1);
      if (syncConsumers > 0) return;
      const stop = stopSharedSync;
      stopSharedSync = undefined;
      stop?.();
    };
  };

  return { useAuthStore, startAuthSync };
}
