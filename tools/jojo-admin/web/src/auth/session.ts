import { create } from "zustand";

export type AdminPermission = "library" | "moderation" | "operations" | "agent";
export interface AdminUser { id: string; email: string; permissions: AdminPermission[] }
interface AdminSession {
  user: AdminUser | null;
  ready: boolean;
  error: string;
  restore: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

async function requestSession(path: string, body?: object): Promise<AdminUser | null> {
  const response = await fetch(`/api/auth/${path}`, body ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  } : undefined);
  const payload = await response.json();
  if (!response.ok) {
    if (path === "session" && response.status === 401) return null;
    throw new Error(payload.message || "暂时无法登录，请稍后重试。");
  }
  return payload.user ?? null;
}

export const useAdminSession = create<AdminSession>((set) => ({
  user: null, ready: false, error: "",
  async restore() {
    try { set({ user: await requestSession("session"), ready: true, error: "" }); }
    catch (error) { set({ user: null, ready: true, error: error instanceof Error ? error.message : "无法验证登录状态。" }); }
  },
  async login(email, password) { set({ user: await requestSession("login", { email, password }), ready: true, error: "" }); },
  async logout() { await requestSession("logout", {}); set({ user: null, error: "" }); },
}));
