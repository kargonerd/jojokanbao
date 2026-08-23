import AsyncStorage from "@react-native-async-storage/async-storage";
import { createJojoAuthClient, createJojoAuthStore } from "@jojo/auth";
import { AppState, Platform } from "react-native";

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const MOBILE_ACCOUNT_CONFIGURED = Boolean(supabaseUrl && publishableKey);

export const mobileAuthClient = createJojoAuthClient({
  supabaseUrl: supabaseUrl || "https://invalid.invalid",
  publishableKey: publishableKey || "missing",
  storageKey: "jojo-mobile-auth-session",
  storage: AsyncStorage,
  detectSessionInUrl: false,
});

const controller = createJojoAuthStore(mobileAuthClient);

export const useMobileAuthStore = controller.useAuthStore;

export function startMobileAuthSync(): () => void {
  if (!MOBILE_ACCOUNT_CONFIGURED) {
    useMobileAuthStore.setState({ initialized: true });
    return () => undefined;
  }
  const stopSync = controller.startAuthSync();
  if (Platform.OS === "web") return stopSync;

  if (AppState.currentState === "active") mobileAuthClient.auth.startAutoRefresh();
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") mobileAuthClient.auth.startAutoRefresh();
    else mobileAuthClient.auth.stopAutoRefresh();
  });

  return () => {
    subscription.remove();
    mobileAuthClient.auth.stopAutoRefresh();
    stopSync();
  };
}
