import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), posthog: false, open: vi.fn() }));
vi.mock("react-native", () => ({ AppState: { addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock("./posthogFlags", () => ({ mobileUsesPostHogFlags: () => mocks.posthog, openMobileFlagSession: mocks.open }));
vi.mock("../account/auth", async () => {
  const { create } = await import("zustand");
  return { mobileAuthClient: { rpc: mocks.rpc }, useMobileAuthStore: create<{ initialized: boolean; user: { id: string } | null }>(() => ({ initialized: false, user: null })) };
});
import { useMobileAuthStore as auth } from "../account/auth";
import { mobileSpeechAllowed, startSpeechFlagSync, useMobileFeatureFlagStore, useSpeechFlagStore } from "./featureFlag";
import { disabledFlags, type FeatureFlagValues } from "@jojo/analytics/flags";
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; auth.setState({ initialized: false, user: null }); mocks.rpc.mockReset(); mocks.open.mockReset(); mocks.posthog = false; });
describe("native frontend rollout gate", () => {
  it("hydrates PostHog only after auth, shares all product decisions and clears on account change", async () => {
    mocks.posthog = true;
    let listener!: (flags: FeatureFlagValues) => void;
    const refresh = vi.fn();
    mocks.open.mockResolvedValueOnce({ cached: () => ({ ...disabledFlags(), "library.bookshelf": true, "reader.speech": true }),
      subscribe: (callback: typeof listener) => { listener = callback; return () => undefined; }, refresh, dispose: vi.fn() });
    mocks.open.mockImplementationOnce(() => new Promise(() => undefined));
    stop = startSpeechFlagSync();
    expect(mocks.open).not.toHaveBeenCalled();
    auth.setState({ initialized: true, user: { id: "a" } as NonNullable<ReturnType<typeof auth.getState>["user"]> });
    await vi.waitFor(() => expect(mobileSpeechAllowed()).toBe(true));
    expect(useMobileFeatureFlagStore.getState().flags["library.bookshelf"]).toBe(true);
    expect(refresh).toHaveBeenCalledOnce();
    expect(mocks.rpc).not.toHaveBeenCalled();
    auth.setState({ user: { id: "b" } as NonNullable<ReturnType<typeof auth.getState>["user"]> });
    expect(mobileSpeechAllowed()).toBe(false);
    listener({ ...disabledFlags(), "reader.speech": true });
    expect(mobileSpeechAllowed()).toBe(false);
    expect(useMobileFeatureFlagStore.getState().flags).toEqual(disabledFlags());
  });
  it("fails closed for guests, missing migration and network errors", async () => {
    stop = startSpeechFlagSync();
    expect(mobileSpeechAllowed()).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    auth.setState({ user: { id: "a" } as NonNullable<ReturnType<typeof auth.getState>["user"]> });
    await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
    expect(mobileSpeechAllowed()).toBe(false);
  });
  it("does not leak a late decision across accounts and stops on sign out", async () => {
    let finish!: (value: unknown) => void;
    mocks.rpc.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    auth.setState({ user: { id: "a" } as NonNullable<ReturnType<typeof auth.getState>["user"]> }); stop = startSpeechFlagSync();
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    auth.setState({ user: { id: "b" } as NonNullable<ReturnType<typeof auth.getState>["user"]> });
    finish({ data: [{ flag_key: "reader.speech", enabled: true }], error: null });
    await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
    expect(mobileSpeechAllowed()).toBe(false);
    useSpeechFlagStore.setState({ userId: "b", enabled: true });
    expect(mobileSpeechAllowed()).toBe(true);
    auth.setState({ user: null });
    expect(mobileSpeechAllowed()).toBe(false);
  });
});
