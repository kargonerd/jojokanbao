import Constants from "expo-constants";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createJojoAuthClient,
  createJojoAuthStore,
  createPersonalInvitationRepository,
} from "@jojo/auth";
import { AppState, Platform } from "react-native";
import { createReaderIdentityCache } from "./readerIdentity";

const accountConfig = Constants.expoConfig?.extra?.account;
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || accountConfig?.supabaseUrl;
const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || accountConfig?.publishableKey;

export const MOBILE_ACCOUNT_CONFIGURED = Boolean(supabaseUrl && publishableKey);

export const mobileAuthClient = createJojoAuthClient({
  supabaseUrl: supabaseUrl || "https://invalid.invalid",
  publishableKey: publishableKey || "missing",
  storageKey: "jojo-mobile-auth-session",
  storage: AsyncStorage,
  detectSessionInUrl: false,
});

export const mobilePersonalInvitationRepository =
  createPersonalInvitationRepository(mobileAuthClient);

const controller = createJojoAuthStore(mobileAuthClient);

export const useMobileAuthStore = controller.useAuthStore;
const readerIdentity = createReaderIdentityCache(useMobileAuthStore, AsyncStorage);

export function useMobileReaderName(): string | null {
  const userId = useMobileAuthStore((state) => state.user?.id);
  const freshName = useMobileAuthStore((state) => state.profile?.id === state.user?.id ? state.profile?.display_name?.trim() : null);
  const cachedName = readerIdentity.useIdentityStore((state) => state.userId === userId ? state.displayName : null);
  return freshName || cachedName || null;
}

function retryMissingProfile() {
  const { user, profile, profileStatus, refreshProfile } = useMobileAuthStore.getState();
  if (user && !profile && profileStatus !== "loading") void refreshProfile();
}

export function startMobileAuthSync(): () => void {
  if (!MOBILE_ACCOUNT_CONFIGURED) {
    useMobileAuthStore.setState({ initialized: true });
    return () => undefined;
  }
  const stopIdentity = readerIdentity.start();
  const stopSync = controller.startAuthSync();
  if (Platform.OS === "web") return () => { stopSync(); stopIdentity(); };

  if (AppState.currentState === "active") mobileAuthClient.auth.startAutoRefresh();
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") {
      mobileAuthClient.auth.startAutoRefresh();
      retryMissingProfile();
    }
    else mobileAuthClient.auth.stopAutoRefresh();
  });

  return () => {
    subscription.remove();
    mobileAuthClient.auth.stopAutoRefresh();
    stopSync();
    stopIdentity();
  };
}
