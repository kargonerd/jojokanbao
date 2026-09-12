import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { analyticsHost } from "@jojo/analytics";
import { flagStorageNamespace, flagValues, type FlagSession } from "@jojo/analytics/flags";

export function mobileUsesPostHogFlags(): boolean {
  return (process.env.EXPO_PUBLIC_FEATURE_FLAG_PROVIDER || Constants.expoConfig?.extra?.featureFlagProvider) === "posthog";
}

export async function openMobileFlagSession(userId: string): Promise<FlagSession> {
  const config = Constants.expoConfig?.extra?.analytics;
  const token = (process.env.EXPO_PUBLIC_POSTHOG_TOKEN || config?.token)?.trim();
  const host = analyticsHost(process.env.EXPO_PUBLIC_POSTHOG_HOST || config?.host);
  if (!token || !host) throw new Error("PostHog feature flag configuration missing");
  const { PostHog } = await import("posthog-react-native");
  const namespace = flagStorageNamespace(token, host, userId);
  // SDK identities are immutable within a session. A late response can only touch that account's storage.
  const client = new PostHog(token, {
    host,
    customStorage: {
      getItem: (key) => AsyncStorage.getItem(`${namespace}:${key}`),
      setItem: (key, value) => AsyncStorage.setItem(`${namespace}:${key}`, value),
    },
    bootstrap: { distinctId: userId, isIdentifiedId: true },
    preloadFeatureFlags: false, disableRemoteConfig: true,
    captureAppLifecycleEvents: false, enableSessionReplay: false, disableSurveys: true,
    setDefaultPersonProperties: false, personProfiles: "never", disableGeoip: true,
    errorTracking: { autocapture: { uncaughtExceptions: false, unhandledRejections: false, console: false, nativeCrashes: false }, exceptionSteps: { enabled: false } },
    before_send: () => null,
  });
  await client.ready(); // Hydrates AsyncStorage only; never await the network at startup.
  client.setPersonPropertiesForFlags({ signed_in: true, account_id: userId }, false);
  const cached = () => flagValues(client.getFeatureFlags());
  return {
    cached,
    subscribe: (listener) => client.onFeatureFlags(() => listener(cached())),
    refresh: () => { void client.reloadFeatureFlagsAsync().catch(() => undefined); },
    dispose: () => { void client.shutdown().catch(() => undefined); },
  };
}
