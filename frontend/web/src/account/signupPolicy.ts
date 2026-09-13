import { SIGNUP_CONFIG_KEY, parseSignupConfig, type SignupConfig } from "@jojo/auth";
import { startConfigSync } from "@jojo/analytics/config-sync";
import { configStorageNamespace } from "@jojo/analytics/config";

export function startSignupPolicy(publish: (config: SignupConfig) => void) {
  const token = import.meta.env.VITE_POSTHOG_TOKEN;
  const host = import.meta.env.VITE_POSTHOG_HOST || "https://us.i.posthog.com";
  const key = `${configStorageNamespace(token || "", host)}.${SIGNUP_CONFIG_KEY}.validated`;
  const sync = startConfigSync({
    open: async () => {
      const { openBrowserConfigSession } = await import("@jojo/analytics/browser-config");
      return openBrowserConfigSession({ token, host, key: SIGNUP_CONFIG_KEY });
    },
    parse: parseSignupConfig, publish,
    foreground: () => document.visibilityState === "visible",
    cache: {
      read: async () => JSON.parse(localStorage.getItem(key) || "null"),
      write: async (value) => { localStorage.setItem(key, JSON.stringify(value)); },
    },
  });
  const foreground = () => { if (document.visibilityState === "visible") sync.refresh(); };
  window.addEventListener("online", foreground);
  window.addEventListener("focus", foreground);
  document.addEventListener("visibilitychange", foreground);
  return { refresh: sync.refresh, stop: () => {
    sync.stop();
    window.removeEventListener("online", foreground);
    window.removeEventListener("focus", foreground);
    document.removeEventListener("visibilitychange", foreground);
  } };
}
