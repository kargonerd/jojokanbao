import type { Session } from "@supabase/supabase-js";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { JojoAuthClient } from "./client";
import { getAuthErrorMessage } from "./errors";
import { createProfileRepository } from "./profile";
import type { AuthState, SignUpInput } from "./types";

export interface AuthActions {
  clearFeedback: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: SignUpInput) => Promise<boolean>;
  confirmSignUp: (email: string, code: string) => Promise<void>;
  resendSignUpCode: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
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

  const useAuthStore = create<AuthStore>((set, get) => ({
    session: null,
    user: null,
    profile: null,
    recoveryPending: false,
    initialized: false,
    busy: false,
    error: null,
    notice: null,

    clearFeedback: () => set({ error: null, notice: null }),

    signIn: async (email, password) => {
      set({ busy: true, error: null, notice: null });
      try {
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw error;
        const profile = data.user ? await profiles.getOrCreate(data.user.id) : null;
        set({ session: data.session, user: data.user, profile, busy: false });
      } catch (error) {
        set({ busy: false, error: getAuthErrorMessage(error) });
        throw error;
      }
    },

    signUp: async ({ email, password, invitationCode }) => {
      set({ busy: true, error: null, notice: null });
      try {
        const { data, error } = await client.auth.signUp({
          email,
          password,
          options: {
            data: { invitation_code: invitationCode.trim() },
          },
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
      set({ busy: true, error: null, notice: null });
      try {
        const { data, error } = await client.auth.verifyOtp({
          email: email.trim(),
          token: code.trim(),
          type: "email",
        });
        if (error) throw error;
        const profile = data.user ? await profiles.getOrCreate(data.user.id) : null;
        set({
          session: data.session,
          user: data.user,
          profile,
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
          email: email.trim(),
        });
        if (error) throw error;
        set({ busy: false, notice: "新的验证码已经发送。" });
      } catch (error) {
        set({ busy: false, error: getAuthErrorMessage(error) });
        throw error;
      }
    },

    signOut: async () => {
      set({ busy: true, error: null, notice: null });
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) {
        set({ busy: false, error: getAuthErrorMessage(error) });
        throw error;
      }
      set({ session: null, user: null, profile: null, recoveryPending: false, busy: false });
    },

    sendPasswordReset: async (email) => {
      set({ busy: true, error: null, notice: null });
      try {
        const { error } = await client.auth.resetPasswordForEmail(email.trim());
        if (error) throw error;
        set({ busy: false, notice: "如果该邮箱已注册，你会收到一封重置密码邮件。" });
      } catch (error) {
        set({ busy: false, error: getAuthErrorMessage(error) });
        throw error;
      }
    },

    verifyPasswordResetCode: async (email, code) => {
      set({ busy: true, recoveryPending: true, error: null, notice: null });
      try {
        const { data, error } = await client.auth.verifyOtp({
          email: email.trim(),
          token: code.trim(),
          type: "recovery",
        });
        if (error) throw error;
        const profile = data.user ? await profiles.getOrCreate(data.user.id) : null;
        set({
          session: data.session,
          user: data.user,
          profile,
          recoveryPending: true,
          busy: false,
          notice: "验证码正确，请设置新密码。",
        });
      } catch (error) {
        set({ busy: false, recoveryPending: false, error: getAuthErrorMessage(error) });
        throw error;
      }
    },

    completePasswordRecovery: async (password) => {
      set({ busy: true, error: null, notice: null });
      try {
        const { error } = await client.auth.updateUser({ password });
        if (error) throw error;
        const { error: signOutError } = await client.auth.signOut({ scope: "others" });
        if (signOutError) throw signOutError;
        set({ recoveryPending: false, busy: false, notice: "密码已更新，其他设备的登录已经退出。" });
      } catch (error) {
        set({ busy: false, error: getAuthErrorMessage(error) });
        throw error;
      }
    },

    changePassword: async (currentPassword, newPassword) => {
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
      try {
        set({ profile: await profiles.getOrCreate(user.id) });
      } catch (error) {
        set({ error: getAuthErrorMessage(error) });
      }
    },

  }));

  const syncSession = async (session: Session | null) => {
    if (!session?.user) {
      useAuthStore.setState({
        session: null,
        user: null,
        profile: null,
        recoveryPending: false,
        initialized: true,
      });
      return;
    }
    try {
      const profile = await profiles.getOrCreate(session.user.id);
      useAuthStore.setState({ session, user: session.user, profile, initialized: true });
    } catch (error) {
      useAuthStore.setState({
        session,
        user: session.user,
        profile: null,
        initialized: true,
        error: getAuthErrorMessage(error),
      });
    }
  };

  const startAuthSync = () => {
    let active = true;
    void client.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) {
        useAuthStore.setState({ initialized: true, error: getAuthErrorMessage(error) });
        return;
      }
      void syncSession(data.session);
    });

    const { data } = client.auth.onAuthStateChange((_event, session) => {
      if (active) void syncSession(session);
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  };

  return { useAuthStore, startAuthSync };
}
