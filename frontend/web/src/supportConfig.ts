import { useEffect } from "react";
import { create } from "zustand";
import { DEFAULT_SUPPORT_CONFIG, SUPPORT_CONFIG_KEY, parseSupportConfig, type SupportConfig } from "@jojo/content";
import { startConfigSync } from "@jojo/analytics/config-sync";
import { flagStorageNamespace } from "@jojo/analytics/flags";

export const useSupportConfigStore = create<SupportConfig>(() => ({ ...DEFAULT_SUPPORT_CONFIG }));
export function useSupportConfig() {
  useEffect(() => {
    const token = import.meta.env.VITE_POSTHOG_TOKEN;
    const host = import.meta.env.VITE_POSTHOG_HOST;
    if (!token) return;
    const key = flagStorageNamespace(token, host || "https://us.i.posthog.com", "validated-support-config");
    const sync = startConfigSync({
      open: async () => {
        const { openBrowserConfigSession } = await import("@jojo/analytics/browser-flags");
        return openBrowserConfigSession({ token, host, key: SUPPORT_CONFIG_KEY });
      },
      parse: parseSupportConfig,
      publish: (config) => useSupportConfigStore.setState(config),
      foreground: () => document.visibilityState === "visible",
      cache: {
        read: async () => JSON.parse(localStorage.getItem(key) || "null"),
        write: async (value) => { localStorage.setItem(key, JSON.stringify(value)); },
      },
    });
    const foreground = () => { if (document.visibilityState === "visible") sync.refresh(); };
    window.addEventListener("focus", foreground);
    window.addEventListener("online", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      sync.stop();
      window.removeEventListener("focus", foreground);
      window.removeEventListener("online", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, []);
  return useSupportConfigStore();
}
