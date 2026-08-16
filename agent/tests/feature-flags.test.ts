import { afterEach, describe, expect, it, vi } from "vitest";
import { requireFeatureFlag } from "../src";

afterEach(() => vi.unstubAllGlobals());

describe("Agent feature flags", () => {
  it("uses the authenticated Supabase rule evaluation", async () => {
    const fetchMock = vi.fn(async () => Response.json([
      { flag_key: "agent.chat", enabled: true, revision: 4 },
    ]));
    vi.stubGlobal("fetch", fetchMock);

    await requireFeatureFlag({
      env: {
        VITE_SUPABASE_URL: "https://example.supabase.co",
        VITE_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
      },
      request: { headers: new Headers({ authorization: "Bearer access-token" }) },
    }, { id: "user-1" }, "agent.chat");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.supabase.co/rest/v1/rpc/get_my_feature_flags",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer access-token" }),
        body: JSON.stringify({ p_keys: ["agent.chat"], p_visitor_id: null }),
      }),
    );
  });

  it("fails closed when the first matching rule serves off", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([
      { flag_key: "agent.chat", enabled: false, revision: 5 },
    ])));

    await expect(requireFeatureFlag({
      env: {
        VITE_SUPABASE_URL: "https://example.supabase.co",
        VITE_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
      },
      request: { headers: new Headers({ authorization: "Bearer access-token" }) },
    }, { id: "user-1" }, "agent.chat")).rejects.toMatchObject({
      status: 403,
      message: "This feature is not available",
    });
  });
});
