import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";

const rpc = vi.hoisted(() => vi.fn());

vi.mock("../src/account/session", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/account/session")>(),
  accountSessionConfigured: true,
}));
vi.mock("../src/account/auth", () => ({ authClient: { rpc } }));

import { refreshFeatureFlags, useFeatureFlag, useFeatureFlagStore } from "../src/featureFlags";
import { useAccountSessionStore } from "../src/account/session";

describe("feature flag store", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    window.localStorage.clear();
    rpc.mockReset();
    useAccountSessionStore.setState({ initialized: true, userId: null, displayName: null });
  });

  it("loads known decisions and fails closed for a missing flag", async () => {
    rpc.mockResolvedValue({
      data: [{ flag_key: "library.bookshelf", enabled: true, revision: 4 }],
      error: null,
    });

    await refreshFeatureFlags();

    expect(rpc).toHaveBeenCalledWith("get_my_feature_flags", expect.objectContaining({
      p_keys: expect.arrayContaining(["library.bookshelf", "reader.annotations"]),
      p_visitor_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    }));
    expect(useFeatureFlagStore.getState().flags["library.bookshelf"]).toBe(true);
    expect(useFeatureFlagStore.getState().flags["reader.annotations"]).toBe(false);
  });

  it("fails closed when evaluation is unavailable", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error("offline") });

    await refreshFeatureFlags();

    expect(useFeatureFlagStore.getState().initialized).toBe(true);
    expect(Object.values(useFeatureFlagStore.getState().flags)).toEqual([false, false, false]);
  });

  it.each([true, false])("only previews speech in the local development server (DEV=%s)", async (dev) => {
    vi.stubEnv("DEV", dev);
    vi.stubEnv("MODE", "development");
    rpc.mockResolvedValue({ data: [], error: null });
    await refreshFeatureFlags();
    const { result } = renderHook(() => ({ speech: useFeatureFlag("reader.speech"), bookshelf: useFeatureFlag("library.bookshelf") }));
    expect(result.current).toEqual({ speech: dev, bookshelf: false });
    expect(useFeatureFlagStore.getState().flags["reader.speech"]).toBe(false);
  });

  it("keeps existing signed-in reading features available before the flag migration", async () => {
    useAccountSessionStore.setState({ initialized: true, userId: "reader-1", displayName: "读者" });
    rpc.mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "Could not find public.get_my_feature_flags in the schema cache" },
    });

    await refreshFeatureFlags();

    expect(useFeatureFlagStore.getState().revision).toBe("migration-pending");
    expect(useFeatureFlagStore.getState().flags).toEqual({
      "library.bookshelf": true,
      "reader.annotations": true,
      "reader.speech": false,
    });
  });
});
