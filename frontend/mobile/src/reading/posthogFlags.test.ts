import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  get: vi.fn(async () => null), set: vi.fn(async () => undefined), construct: vi.fn(),
  sdk: { ready: vi.fn(async () => undefined), setPersonPropertiesForFlags: vi.fn(), getFeatureFlags: vi.fn(() => ({ "reader_speech": true })),
    getFeatureFlagPayload: vi.fn(() => ({qqGroup: "123456789"})),
    onFeatureFlags: vi.fn(() => () => undefined), reloadFeatureFlagsAsync: vi.fn(async () => undefined), shutdown: vi.fn(async () => undefined) },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: mocks.get, setItem: mocks.set } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: { featureFlagProvider: "posthog", analytics: { token: "phc_test", host: "https://us.i.posthog.com" } } } } }));
vi.mock("posthog-react-native", () => ({ PostHog: class { constructor(...args: unknown[]) { mocks.construct(...args); return mocks.sdk; } } }));
import { openMobileFlagSession, openMobileConfigSession, mobileUsesPostHogFlags } from "./posthogFlags";
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("EXPO_PUBLIC_POSTHOG_TOKEN", ""); vi.stubEnv("EXPO_PUBLIC_POSTHOG_HOST", ""); vi.stubEnv("EXPO_PUBLIC_FEATURE_FLAG_PROVIDER", ""); });
afterEach(() => vi.unstubAllEnvs());

it("opens the persisted cache without waiting for a flag request and sends no analytics", async () => {
  const session = await openMobileFlagSession("reader-a");
  expect(mocks.sdk.ready).toHaveBeenCalledOnce();
  expect(mocks.sdk.reloadFeatureFlagsAsync).not.toHaveBeenCalled();
  expect(session.cached()["reader.speech"]).toBe(true);
  const options = mocks.construct.mock.calls[0]![1];
  expect(options).toMatchObject({ preloadFeatureFlags: false, personProfiles: "never", bootstrap: { distinctId: "reader-a" } });
  expect(options.before_send({ event: "$identify", properties: {} })).toBeNull();
  session.refresh();
  expect(mocks.sdk.reloadFeatureFlagsAsync).toHaveBeenCalledOnce();
  session.dispose();
});

it("isolates SDK storage by account and project while keeping a stable restart namespace", async () => {
  const first = await openMobileFlagSession("reader-a");
  const second = await openMobileFlagSession("reader-b");
  const third = await openMobileFlagSession("reader-a");
  vi.stubEnv("EXPO_PUBLIC_POSTHOG_TOKEN", "phc_other");
  const fourth = await openMobileFlagSession("reader-a");
  for (const [, options] of mocks.construct.mock.calls) await options.customStorage.getItem("posthog");
  const keys = mocks.get.mock.calls.map((args: unknown[]) => args[0]);
  expect(keys[0]).not.toBe(keys[1]);
  expect(keys[0]).toBe(keys[2]);
  expect(keys[0]).not.toBe(keys[3]);
  expect(keys[0]).not.toBe("posthog");
  [first, second, third, fourth].forEach((session) => session.dispose());
});

it("reads the manifest provider and allows an explicit environment override", () => {
  expect(mobileUsesPostHogFlags()).toBe(true);
  vi.stubEnv("EXPO_PUBLIC_FEATURE_FLAG_PROVIDER", "supabase");
  expect(mobileUsesPostHogFlags()).toBe(false);
});

it("loads guest configuration even when product flags use the old provider", async () => {
  vi.stubEnv("EXPO_PUBLIC_FEATURE_FLAG_PROVIDER", "supabase");
  const session = await openMobileConfigSession("support_config");
  expect(session.cached()).toEqual({qqGroup: "123456789"});
  expect(mocks.sdk.getFeatureFlagPayload).toHaveBeenCalledWith("support_config");
  expect(mocks.construct.mock.calls[0]![1]).toMatchObject({bootstrap: {distinctId: "jojo-public-config", isIdentifiedId: false}});
  expect(mocks.sdk.setPersonPropertiesForFlags).toHaveBeenCalledExactlyOnceWith({signed_in: false}, false);
  expect(mocks.sdk.reloadFeatureFlagsAsync).not.toHaveBeenCalled();
  session.dispose();
});
