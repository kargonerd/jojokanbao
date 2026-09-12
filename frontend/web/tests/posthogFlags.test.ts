import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { disabledFlags } from "@jojo/analytics/flags";
const mocks = vi.hoisted(() => ({ open: vi.fn(), rpc: vi.fn() }));
vi.mock("@jojo/analytics/browser-flags", () => ({ openBrowserFlagSession: mocks.open }));
vi.mock("../src/account/session", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/account/session")>(), accountSessionConfigured: true,
}));
vi.mock("../src/account/auth", () => ({ authClient: { rpc: mocks.rpc } }));
import { useAccountSessionStore as auth } from "../src/account/session";
import { startFeatureFlagSync, useFeatureFlagStore } from "../src/featureFlags";
let stop: (() => void) | undefined;
beforeEach(() => { vi.stubEnv("VITE_FEATURE_FLAG_PROVIDER", "posthog"); vi.clearAllMocks(); auth.setState({ initialized: false, userId: null }); });
afterEach(() => { stop?.(); vi.unstubAllEnvs(); });

it("starts from cache after auth and clears synchronously on logout without calling legacy RPC", async () => {
  const refresh = vi.fn();
  mocks.open.mockResolvedValue({ cached: () => ({ ...disabledFlags(), "reader.speech": true }),
    refresh, subscribe: () => () => undefined, dispose: vi.fn() });
  stop = startFeatureFlagSync();
  expect(mocks.open).not.toHaveBeenCalled();
  auth.setState({ initialized: true, userId: "reader-a", analyticsExcluded: true });
  await vi.waitFor(() => expect(useFeatureFlagStore.getState().flags["reader.speech"]).toBe(true));
  expect(useFeatureFlagStore.getState().initialized).toBe(true);
  expect(refresh).toHaveBeenCalledOnce();
  expect(mocks.rpc).not.toHaveBeenCalled();
  auth.setState({ userId: null });
  expect(useFeatureFlagStore.getState().flags).toEqual(disabledFlags());
});

it("uses safe defaults when explicitly switched but PostHog configuration is missing", async () => {
  mocks.open.mockRejectedValue(new Error("missing config"));
  auth.setState({ initialized: true, userId: "reader-a" });
  stop = startFeatureFlagSync();
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalled());
  expect(useFeatureFlagStore.getState()).toMatchObject({ initialized: true, revision: "posthog", flags: disabledFlags() });
  expect(mocks.rpc).not.toHaveBeenCalled();
});
