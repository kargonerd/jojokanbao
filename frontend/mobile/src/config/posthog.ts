import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { analyticsHost } from "@jojo/analytics";
import { configStorageNamespace, type ConfigSession } from "@jojo/analytics/config";

async function mobileConfigClient() {
  const config = Constants.expoConfig?.extra?.analytics;
  const token = (process.env.EXPO_PUBLIC_POSTHOG_TOKEN || config?.token)?.trim();
  const host = analyticsHost(process.env.EXPO_PUBLIC_POSTHOG_HOST || config?.host || "https://us.i.posthog.com");
  if (!token || !host) throw new Error("PostHog configuration missing");
  const { PostHog } = await import("posthog-react-native");
  const namespace = configStorageNamespace(token, host);
  // Keep public configuration storage separate from analytics and other projects.
  const client = new PostHog(token, {
    host,
    customStorage: {
      getItem: (key) => AsyncStorage.getItem(`${namespace}:${key}`),
      setItem: (key, value) => AsyncStorage.setItem(`${namespace}:${key}`, value),
    },
    bootstrap: { distinctId: "jojo-public-config", isIdentifiedId: false },
    preloadFeatureFlags: false, disableRemoteConfig: true,
    captureAppLifecycleEvents: false, enableSessionReplay: false, disableSurveys: true,
    setDefaultPersonProperties: false, personProfiles: "never", disableGeoip: true,
    errorTracking: { autocapture: { uncaughtExceptions: false, unhandledRejections: false, console: false, nativeCrashes: false }, exceptionSteps: { enabled: false } },
    before_send: () => null,
  });
  await client.ready(); // Hydrates AsyncStorage only; never await the network at startup.
  client.setPersonPropertiesForFlags({ signed_in: false }, false);
  return client;
}

export async function openMobileConfigSession(key: string): Promise<ConfigSession> {
  const client = await mobileConfigClient();
  const cached = () => client.getFeatureFlagPayload(key);
  return {
    cached,
    subscribe: (listener) => client.onFeatureFlags(() => listener(cached())),
    refresh: () => { void client.reloadFeatureFlagsAsync().catch(() => undefined); },
    dispose: () => { void client.shutdown().catch(() => undefined); },
  };
}
