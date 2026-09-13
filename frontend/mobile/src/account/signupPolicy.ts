import { AppState } from "react-native";
import Constants from "expo-constants";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SIGNUP_CONFIG_KEY, parseSignupConfig, type SignupConfig } from "@jojo/auth";
import { startConfigSync } from "@jojo/analytics/config-sync";
import { configStorageNamespace } from "@jojo/analytics/config";

export function startSignupPolicy(publish: (config: SignupConfig) => void) {
  const config = Constants.expoConfig?.extra?.analytics;
  const token = process.env.EXPO_PUBLIC_POSTHOG_TOKEN || config?.token || "";
  const host = process.env.EXPO_PUBLIC_POSTHOG_HOST || config?.host || "https://us.i.posthog.com";
  const key = `${configStorageNamespace(token, host)}.${SIGNUP_CONFIG_KEY}.validated`;
  const sync = startConfigSync({
    open: async () => {
      const { openMobileConfigSession } = await import("../config/posthog");
      return openMobileConfigSession(SIGNUP_CONFIG_KEY);
    },
    parse: parseSignupConfig, publish,
    foreground: () => AppState.currentState === "active",
    cache: {
      read: async () => JSON.parse(await AsyncStorage.getItem(key) || "null"),
      write: (value) => AsyncStorage.setItem(key, JSON.stringify(value)),
    },
  });
  const subscription = AppState.addEventListener("change", (state) => { if (state === "active") sync.refresh(); });
  return { refresh: sync.refresh, stop: () => { subscription.remove(); sync.stop(); } };
}
