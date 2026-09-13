import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configStorageNamespace } from "@jojo/analytics/config";
import { getRegistrationValidationError } from "./registration";

const mocks = vi.hoisted(() => ({
  get: vi.fn(), set: vi.fn(async () => undefined), remove: vi.fn(),
  open: vi.fn(), refresh: vi.fn(), dispose: vi.fn(), unsubscribe: vi.fn(),
  receive: undefined as undefined | ((value: unknown) => void),
  foreground: undefined as undefined | ((state: string) => void),
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: { analytics: { token: "phc_test", host: "https://us.i.posthog.com" } } } } }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: mocks.get, setItem: mocks.set } }));
vi.mock("react-native", () => ({ AppState: { currentState: "active", addEventListener: (_name: string, callback: (state: string) => void) => {
  mocks.foreground = callback;
  return { remove: mocks.remove };
} } }));
vi.mock("../config/posthog", () => ({ openMobileConfigSession: mocks.open }));
import { startSignupPolicy } from "./signupPolicy";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubEnv("EXPO_PUBLIC_POSTHOG_TOKEN", "");
  vi.stubEnv("EXPO_PUBLIC_POSTHOG_HOST", "");
  mocks.get.mockResolvedValue('{"invitationRequired":false}');
  mocks.open.mockResolvedValue({ cached: () => undefined, refresh: mocks.refresh, dispose: mocks.dispose,
    subscribe: (callback: (value: unknown) => void) => { mocks.receive = callback; return mocks.unsubscribe; } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

it("uses cached open signup immediately, subscribes to the shared PostHog key and refreshes on foreground", async () => {
  const publish = vi.fn();
  const sync = startSignupPolicy(publish);
  try {
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith("auth_signup_config");
    expect(mocks.get).toHaveBeenCalledWith(`${configStorageNamespace("phc_test", "https://us.i.posthog.com")}.auth_signup_config.validated`);
    expect(publish).toHaveBeenLastCalledWith({ invitationRequired: false });
    expect(getRegistrationValidationError("", "password123", publish.mock.lastCall![0].invitationRequired)).toBeNull();
    mocks.receive!({ invitationRequired: true });
    expect(publish).toHaveBeenLastCalledWith({ invitationRequired: true });
    await vi.waitFor(() => expect(mocks.set).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(30_000);
    mocks.foreground!("active");
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  } finally { sync.stop(); }
  expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  expect(mocks.remove).toHaveBeenCalledOnce();
});

it("retains the validated signup policy when PostHog supplies an invalid payload", async () => {
  const publish = vi.fn();
  const sync = startSignupPolicy(publish);
  try {
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    mocks.receive!({ invitationRequired: "true" });
    mocks.receive!(undefined);
    expect(publish).toHaveBeenCalledExactlyOnceWith({ invitationRequired: false });
    expect(mocks.set).not.toHaveBeenCalled();
  } finally { sync.stop(); }
});
