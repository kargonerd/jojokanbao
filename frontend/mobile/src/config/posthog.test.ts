import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  get: vi.fn(async () => null), set: vi.fn(async () => undefined), construct: vi.fn(),
  sdk: { ready: vi.fn(async () => undefined), setPersonPropertiesForFlags: vi.fn(),
    getFeatureFlagPayload: vi.fn(() => ({qqGroup: "123456789"})),
    onFeatureFlags: vi.fn(() => () => undefined), reloadFeatureFlagsAsync: vi.fn(async () => undefined), shutdown: vi.fn(async () => undefined) },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: mocks.get, setItem: mocks.set } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: { analytics: { token: "phc_test", host: "https://us.i.posthog.com" } } } } }));
vi.mock("posthog-react-native", () => ({ PostHog: class { constructor(...args: unknown[]) { mocks.construct(...args); return mocks.sdk; } } }));
import { openMobileConfigSession } from "./posthog";
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("EXPO_PUBLIC_POSTHOG_TOKEN", ""); vi.stubEnv("EXPO_PUBLIC_POSTHOG_HOST", ""); });
afterEach(() => vi.unstubAllEnvs());

it("opens the persisted cache without waiting for a flag request and sends no analytics", async () => {
  const session = await openMobileConfigSession("support_config");
  expect(mocks.sdk.ready).toHaveBeenCalledOnce();
  expect(mocks.sdk.reloadFeatureFlagsAsync).not.toHaveBeenCalled();
  expect(session.cached()).toEqual({qqGroup: "123456789"});
  const options = mocks.construct.mock.calls[0]![1];
  expect(options).toMatchObject({ preloadFeatureFlags: false, personProfiles: "never", bootstrap: { distinctId: "jojo-public-config" } });
  expect(options.before_send({ event: "$identify", properties: {} })).toBeNull();
  session.refresh();
  expect(mocks.sdk.reloadFeatureFlagsAsync).toHaveBeenCalledOnce();
  session.dispose();
});

it("isolates SDK storage by project while keeping a stable restart namespace", async () => {
  const first = await openMobileConfigSession("support_config");
  const second = await openMobileConfigSession("support_config");
  const third = await openMobileConfigSession("support_config");
  vi.stubEnv("EXPO_PUBLIC_POSTHOG_TOKEN", "phc_other");
  const fourth = await openMobileConfigSession("support_config");
  for (const [, options] of mocks.construct.mock.calls) await options.customStorage.getItem("posthog");
  const keys = mocks.get.mock.calls.map((args: unknown[]) => args[0]);
  expect(keys[0]).toBe(keys[1]);
  expect(keys[0]).toBe(keys[2]);
  expect(keys[0]).not.toBe(keys[3]);
  expect(keys[0]).not.toBe("posthog");
  [first, second, third, fourth].forEach((session) => session.dispose());
});



it("loads public configuration without login", async () => {
  const session = await openMobileConfigSession("support_config");
  expect(session.cached()).toEqual({qqGroup: "123456789"});
  expect(mocks.sdk.getFeatureFlagPayload).toHaveBeenCalledWith("support_config");
  expect(mocks.construct.mock.calls[0]![1]).toMatchObject({bootstrap: {distinctId: "jojo-public-config", isIdentifiedId: false}});
  expect(mocks.sdk.setPersonPropertiesForFlags).toHaveBeenCalledExactlyOnceWith({signed_in: false}, false);
  expect(mocks.sdk.reloadFeatureFlagsAsync).not.toHaveBeenCalled();
  session.dispose();
});
