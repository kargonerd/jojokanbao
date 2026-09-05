import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("react-native", () => ({ AppState: { addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock("../account/auth", async () => {
  const { create } = await import("zustand");
  return { mobileAuthClient: { rpc: mocks.rpc }, useMobileAuthStore: create<{ user: { id: string } | null }>(() => ({ user: null })) };
});
import { useMobileAuthStore as auth } from "../account/auth";
import { mobileSpeechAllowed, startSpeechFlagSync, useSpeechFlagStore } from "./featureFlag";
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; auth.setState({ user: null }); mocks.rpc.mockReset(); });
describe("native frontend rollout gate", () => {
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
