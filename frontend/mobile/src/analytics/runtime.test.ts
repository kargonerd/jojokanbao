import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  preferences: { analyticsEnabled: true }, hydrated: false,
  auth: { initialized: false, user: null as null | { id: string; user_metadata?: Record<string, unknown> } },
  hydrate: [] as Array<() => void>, preferencesChanged: [] as Array<() => void>, authChanged: [] as Array<() => void>,
  sdk: { capture: vi.fn(), identify: vi.fn(), reset: vi.fn(), getPersistedProperty: vi.fn(), getDistinctId: vi.fn(),
    captureException: vi.fn(), register: vi.fn(), ready: vi.fn(async () => undefined), optIn: vi.fn(async () => undefined), optOut: vi.fn(async () => undefined) },
  construct: vi.fn(),
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => "saved-installation", setItem: vi.fn() } }));
vi.mock("expo-application", () => ({ nativeApplicationVersion: "0.0.3" }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: { analytics: { token: "phc_test", host: "https://us.i.posthog.com" } } } } }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "new-installation" }));
vi.mock("react-native", () => ({ Platform: { OS: "android" }, AppState: { currentState: "active", addEventListener: vi.fn() } }));
vi.mock("../config/appVariant", () => ({ IS_EINK_RELEASE: true }));
vi.mock("../account/auth", () => ({ useMobileAuthStore: { getState: () => mocks.auth, subscribe: (callback: () => void) => { mocks.authChanged.push(callback); } } }));
vi.mock("../store/mobileStore", () => ({ useMobileStore: {
  getState: () => mocks.preferences, subscribe: (callback: () => void) => { mocks.preferencesChanged.push(callback); },
  persist: { hasHydrated: () => mocks.hydrated, onFinishHydration: (callback: () => void) => { mocks.hydrate.push(callback); return () => undefined; } },
} }));
vi.mock("posthog-react-native", () => ({ PostHog: class { constructor(...args: unknown[]) { mocks.construct(...args); return mocks.sdk; } }, PostHogPersistedProperty: { PersonMode: "person_mode" } }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.stubGlobal("__DEV__", false);
  vi.stubEnv("EXPO_PUBLIC_POSTHOG_TOKEN", ""); vi.stubEnv("EXPO_PUBLIC_POSTHOG_HOST", "");
  mocks.preferences.analyticsEnabled = true; mocks.hydrated = false; mocks.auth = { initialized: false, user: null };
  mocks.hydrate = []; mocks.authChanged = []; mocks.preferencesChanged = [];
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("waits for preferences and authentication without losing the initial screen", async () => {
  const { initializeMobileAnalytics } = await import("./runtime");
  const { analytics } = await import("@jojo/analytics");
  const initializing = initializeMobileAnalytics();
  analytics.screen("home");
  expect(mocks.construct).not.toHaveBeenCalled();
  mocks.hydrated = true; mocks.hydrate.forEach((callback) => callback());
  await initializing;
  expect(mocks.sdk.capture).not.toHaveBeenCalled();
  mocks.auth = { initialized: true, user: { id: "reader" } }; mocks.authChanged.forEach((callback) => callback());
  expect(mocks.sdk.identify).toHaveBeenCalledWith("reader");
  expect(mocks.sdk.capture.mock.calls.map(([event]) => event)).toEqual(["app_started", "app_active", "screen_viewed"]);
  expect(mocks.sdk.capture).toHaveBeenLastCalledWith("screen_viewed", expect.objectContaining({ screen: "home", platform: "android", app_variant: "eink", installation_id: "saved-installation" }));
  mocks.preferences.analyticsEnabled = false; mocks.preferencesChanged.forEach((callback) => callback());
  expect(mocks.sdk.optOut).toHaveBeenCalled();
  const config = mocks.construct.mock.calls[0]![1];
  expect(config.before_send({ properties: {} })).toBeNull();
});

it("drops events for an opted-out installation or monitor account", async () => {
  mocks.preferences.analyticsEnabled = false; mocks.hydrated = true;
  mocks.auth = { initialized: true, user: { id: "monitor", user_metadata: { account_purpose: "ai_availability_monitor" } } };
  const { initializeMobileAnalytics } = await import("./runtime");
  const { analytics } = await import("@jojo/analytics");
  analytics.screen("home"); await initializeMobileAnalytics();
  mocks.preferences.analyticsEnabled = true; mocks.preferencesChanged.forEach((callback) => callback());
  expect(mocks.sdk.capture).not.toHaveBeenCalled(); expect(mocks.sdk.identify).not.toHaveBeenCalled();
});

it("does not instantiate the SDK in development", async () => {
  vi.stubGlobal("__DEV__", true);
  await (await import("./runtime")).initializeMobileAnalytics();
  expect(mocks.construct).not.toHaveBeenCalled();
});
