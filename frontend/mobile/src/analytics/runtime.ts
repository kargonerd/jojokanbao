import AsyncStorage from "@react-native-async-storage/async-storage";
import { analytics, analyticsHost, isMonitorUser } from "@jojo/analytics";
import { sanitizePostHogEvent } from "@jojo/analytics/sanitize";
import { nativeApplicationVersion } from "expo-application";
import Constants from "expo-constants";
import { randomUUID } from "expo-crypto";
import { AppState, Platform } from "react-native";
import { useMobileAuthStore } from "../account/auth";
import { IS_EINK_RELEASE } from "../config/appVariant";
import { useMobileStore } from "../store/mobileStore";

let initialized = false;
export async function initializeMobileAnalytics(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const config = Constants.expoConfig?.extra?.analytics;
  const token = process.env.EXPO_PUBLIC_POSTHOG_TOKEN || config?.token;
  const host = analyticsHost(process.env.EXPO_PUBLIC_POSTHOG_HOST || config?.host);
  if (__DEV__ || !token || !host) { analytics.setConsent(false); return; }
  try {
    if (!useMobileStore.persist.hasHydrated()) {
      await new Promise<void>((resolve) => {
        const unsubscribe = useMobileStore.persist.onFinishHydration(() => { unsubscribe(); resolve(); });
        if (useMobileStore.persist.hasHydrated()) { unsubscribe(); resolve(); }
      });
    }
    const { PostHog, PostHogPersistedProperty } = await import("posthog-react-native");
    const client = new PostHog(token, {
      host, customStorage: AsyncStorage,
      captureAppLifecycleEvents: false,
      enableSessionReplay: false,
      disableSurveys: true,
      preloadFeatureFlags: false,
      disableRemoteConfig: true,
      setDefaultPersonProperties: false,
      disableGeoip: true,
      errorTracking: {
        autocapture: { uncaughtExceptions: true, unhandledRejections: true, console: false, nativeCrashes: false },
        exceptionSteps: { enabled: false },
      },
      before_send: (event) => event && analytics.enabled ? sanitizePostHogEvent(event) : null,
    });
    await client.ready();
    let installationId = await AsyncStorage.getItem("jojo.analytics.installation.v1");
    if (!installationId) {
      installationId = randomUUID();
      await AsyncStorage.setItem("jojo.analytics.installation.v1", installationId);
    }
    const consent = () => analytics.setConsent(useMobileStore.getState().analyticsEnabled);
    const identity = () => {
      const { initialized: ready, user } = useMobileAuthStore.getState();
      analytics.setIdentity({ initialized: ready, userId: user?.id ?? null, excluded: isMonitorUser(user) });
    };
    consent();
    identity();
    const context = { client: "mobile" as const, platform: Platform.OS, app_variant: IS_EINK_RELEASE ? "eink" : "standard",
      release_channel: "stable", app_version: nativeApplicationVersion || Constants.expoConfig?.version || "unknown",
      installation_id: installationId };
    client.register(context);
    let sdkEnabled: boolean | undefined;
    analytics.install({
      capture: (event, properties) => client.capture(event, properties),
      identify: (id) => client.identify(id),
      identifiedId: () => client.getPersistedProperty(PostHogPersistedProperty.PersonMode) === "identified" ? client.getDistinctId() : undefined,
      reset: () => { client.reset(); client.register(context); },
      setEnabled: (enabled) => {
        if (enabled === sdkEnabled) return;
        sdkEnabled = enabled;
        void (enabled ? client.optIn() : client.optOut()).catch(() => undefined);
      },
      exception: (error, properties) => client.captureException(error, properties),
    }, context);
    useMobileStore.subscribe(consent);
    useMobileAuthStore.subscribe(identity);
    analytics.setForeground(AppState.currentState === "active");
    AppState.addEventListener("change", (state) => analytics.setForeground(state === "active"));
  } catch { /* Telemetry failure must not affect the reader. */ }
}
