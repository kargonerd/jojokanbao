import { useEffect } from "react";
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { create } from "zustand";
import { DEFAULT_SUPPORT_CONFIG, SUPPORT_CONFIG_KEY, parseSupportConfig, type SupportConfig } from "@jojo/content";
import { startConfigSync } from "@jojo/analytics/config-sync";
import { configStorageNamespace } from "@jojo/analytics/config";

export const useSupportConfigStore = create<SupportConfig>(() => ({ ...DEFAULT_SUPPORT_CONFIG }));
export function useSupportConfig() {
  useEffect(() => {
    const analytics = Constants.expoConfig?.extra?.analytics;
    const token = process.env.EXPO_PUBLIC_POSTHOG_TOKEN || analytics?.token;
    const host = process.env.EXPO_PUBLIC_POSTHOG_HOST || analytics?.host || "https://us.i.posthog.com";
    if (!token) return;
    const key = `${configStorageNamespace(token, host)}.validated`;
    const sync = startConfigSync({
      open: async () => {
        const { openMobileConfigSession } = await import("./posthog");
        return openMobileConfigSession(SUPPORT_CONFIG_KEY);
      },
      parse: parseSupportConfig,
      publish: (config) => useSupportConfigStore.setState(config),
      foreground: () => AppState.currentState === "active",
      cache: {
        read: async () => JSON.parse(await AsyncStorage.getItem(key) || "null"),
        write: (value) => AsyncStorage.setItem(key, JSON.stringify(value)),
      },
    });
    const subscription = AppState.addEventListener("change", (state) => { if (state === "active") sync.refresh(); });
    return () => { subscription.remove(); sync.stop(); };
  }, []);
  return useSupportConfigStore();
}
