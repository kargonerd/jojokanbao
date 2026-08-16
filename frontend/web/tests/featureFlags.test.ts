import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());

vi.mock("../src/platform/accountSession", () => ({ platformAccountConfigured: true }));
vi.mock("../src/account/auth", () => ({ authClient: { rpc } }));

import { refreshFeatureFlags, useFeatureFlagStore } from "../src/featureFlags";

describe("feature flag store", () => {
  beforeEach(() => {
    window.localStorage.clear();
    rpc.mockReset();
  });

  it("loads known decisions and fails closed for a missing flag", async () => {
    rpc.mockResolvedValue({
      data: [{ flag_key: "library.bookshelf", enabled: true, revision: 4 }],
      error: null,
    });

    await refreshFeatureFlags();

    expect(rpc).toHaveBeenCalledWith("get_my_feature_flags", expect.objectContaining({
      p_keys: expect.arrayContaining(["library.bookshelf", "olds.workspace"]),
      p_visitor_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    }));
    expect(useFeatureFlagStore.getState().flags["library.bookshelf"]).toBe(true);
    expect(useFeatureFlagStore.getState().flags["olds.workspace"]).toBe(false);
  });

  it("fails closed when evaluation is unavailable", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error("offline") });

    await refreshFeatureFlags();

    expect(useFeatureFlagStore.getState().initialized).toBe(true);
    expect(Object.values(useFeatureFlagStore.getState().flags)).toEqual([false, false, false, false]);
  });
});
