import { create } from "zustand";
import { adminApi } from "../api";

interface AdminAuthState {
  token: string | null;
  isAuthenticated: boolean;
  login: (password: string) => Promise<boolean>;
  logout: () => void;
  checkAuth: () => void;
}

export const useAdminAuthStore = create<AdminAuthState>((set) => ({
  token: localStorage.getItem("admin-token"),
  isAuthenticated: !!localStorage.getItem("admin-token"),

  login: async (password) => {
    try {
      const { token } = await adminApi.login(password);
      localStorage.setItem("admin-token", token);
      set({ token, isAuthenticated: true });
      return true;
    } catch { return false; }
  },

  logout: () => {
    localStorage.removeItem("admin-token");
    set({ token: null, isAuthenticated: false });
  },

  checkAuth: () => {
    const token = localStorage.getItem("admin-token");
    set({ token, isAuthenticated: !!token });
  },
}));
