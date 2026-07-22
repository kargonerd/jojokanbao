import type { Session } from "@supabase/supabase-js";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { JojoAuthClient } from "./client";
import { getAuthErrorMessage } from "./errors";
import type { AuthState, Profile, SignUpInput, UpdateProfileInput } from "./types";

export interface AuthActions {
  clearFeedback: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: SignUpInput) => Promise<boolean>;
  signOut: () => Promise<void>;
  sendPasswordReset: (email: string, redirectTo: string) => Promise<void>;
  updatePassword: (password: string) => Promise<void>;
  refreshProfile: () => Promise<void>;
  updateProfile: (input: UpdateProfileInput) => Promise<void>;
  uploadAvatar: (file: File) => Promise<void>;
}

export type AuthStore = AuthState & AuthActions;
export type JojoAuthStore = UseBoundStore<StoreApi<AuthStore>>;

export interface JojoAuthController {
  useAuthStore: JojoAuthStore;
  startAuthSync: () => () => void;
}

export function createJojoAuthStore(client: JojoAuthClient): JojoAuthController {
  const loadProfile = async (userId: string): Promise<Profile | null> => {
    const { data, error } = await client.from("profiles").select("*").eq("id", userId).maybeSingle();
    if (error) throw error;
    if (data) return data;

    const { data: created, error: createError } = await client
      .from("profiles")
      .insert({ id: userId })
      .select("*")
      .single();
    if (createError) throw createError;
    return created;
  };

  const useAuthStore = create<AuthStore>((set, get) => ({
    session: null,
    user: null,
    profile: null,
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
        const profile = data.user ? await loadProfile(data.user.id) : null;
        set({ session: data.session, user: data.user, profile, busy: false });
      } catch (error) {
        set({ busy: false, error: getAuthErrorMessage(error) });
        throw error;
      }
    },

    signUp: async ({ email, password, displayName, invitationCode, emailRedirectTo }) => {
      set({ busy: true, error: null, notice: null });
      try {
        const { data, error } = await client.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo,
            data: {
              display_name: displayName.trim() || undefined,
              invitation_code: invitationCode.trim(),
            },
          },
        });
        if (error) throw error;
        const requiresEmailConfirmation = data.session === null;
        set({
          session: data.session,
          user: data.user,
          busy: false,
          notice: requiresEmailConfirmation
            ? "确认邮件已经发出，请打开邮件完成注册。"
            : "账号已经创建。",
        });
        return requiresEmailConfirmation;
      } catch (error) {
        set({ busy: false, error: getAuthErrorMessage(error) });
        throw error;
      }
    },

    signOut: async () => {
      set({ busy: true, error: null, notice: null });
      const { error } = await client.auth.signOut();
      if (error) {
        set({ busy: false, error: getAuthErrorMessage(error) });
        throw error;
      }
      set({ session: null, user: null, profile: null, busy: false });
    },

    sendPasswordReset: async (email, redirectTo) => {
      set({ busy: true, error: null, notice: null });
      try {
        const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) throw error;
        set({ busy: false, notice: "如果该邮箱已注册，你会收到一封重置密码邮件。" });
      } catch (error) {
        set({ busy: false, error: getAuthErrorMessage(error) });
        throw error;
      }
    },

    updatePassword: async (password) => {
      set({ busy: true, error: null, notice: null });
      try {
        const { error } = await client.auth.updateUser({ password });
        if (error) throw error;
        set({ busy: false, notice: "密码已更新，下次请使用新密码登录。" });
      } catch (error) {
        set({ busy: false, error: getAuthErrorMessage(error) });
        throw error;
      }
    },

    refreshProfile: async () => {
      const user = get().user;
      if (!user) return;
      try {
        set({ profile: await loadProfile(user.id) });
      } catch (error) {
        set({ error: getAuthErrorMessage(error) });
      }
    },

    updateProfile: async ({ displayName, avatarPath }) => {
      const user = get().user;
      if (!user) throw new Error("Not authenticated");
      set({ busy: true, error: null, notice: null });
      try {
        const values = {
          id: user.id,
          display_name: displayName.trim() || null,
          ...(avatarPath !== undefined ? { avatar_path: avatarPath } : {}),
        };
        const { data, error } = await client.from("profiles").upsert(values).select("*").single();
        if (error) throw error;
        set({ profile: data, busy: false, notice: "账号资料已保存。" });
      } catch (error) {
        set({ busy: false, error: getAuthErrorMessage(error) });
        throw error;
      }
    },

    uploadAvatar: async (file) => {
      const { user, profile } = get();
      if (!user) throw new Error("Not authenticated");
      set({ busy: true, error: null, notice: null });
      try {
        const extension = file.name.split(".").pop()?.toLowerCase() || "jpg";
        const path = `${user.id}/${crypto.randomUUID()}.${extension}`;
        const { error: uploadError } = await client.storage.from("avatars").upload(path, file, {
          cacheControl: "3600",
          contentType: file.type,
          upsert: false,
        });
        if (uploadError) throw uploadError;

        const { data, error } = await client
          .from("profiles")
          .upsert({ id: user.id, avatar_path: path })
          .select("*")
          .single();
        if (error) {
          await client.storage.from("avatars").remove([path]);
          throw error;
        }

        if (profile?.avatar_path) {
          await client.storage.from("avatars").remove([profile.avatar_path]);
        }
        set({ profile: data, busy: false, notice: "头像已更新。" });
      } catch (error) {
        set({ busy: false, error: getAuthErrorMessage(error) });
        throw error;
      }
    },
  }));

  const syncSession = async (session: Session | null) => {
    if (!session?.user) {
      useAuthStore.setState({ session: null, user: null, profile: null, initialized: true });
      return;
    }
    try {
      const profile = await loadProfile(session.user.id);
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
