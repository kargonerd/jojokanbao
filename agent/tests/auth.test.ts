import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHttpError, authorizeSupabaseUser } from "../src";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authorizeSupabaseUser", () => {
  it("uses the same bearer-token validation as the Python API", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ id: "user-123" }, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(authorizeSupabaseUser({
      env: {
        VITE_SUPABASE_URL: "https://example.supabase.co",
        VITE_SUPABASE_PUBLISHABLE_KEY: "publishable",
      },
      request: {
        headers: new Headers({ authorization: "Bearer access-token" }),
      },
    })).resolves.toEqual({ id: "user-123" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.supabase.co/auth/v1/user",
      expect.objectContaining({
        headers: expect.objectContaining({
          apikey: "publishable",
          authorization: "Bearer access-token",
        }),
      }),
    );
  });

  it("rejects requests without a JOJO login", async () => {
    await expect(authorizeSupabaseUser({
      env: {
        VITE_SUPABASE_URL: "https://example.supabase.co",
        VITE_SUPABASE_PUBLISHABLE_KEY: "publishable",
      },
      request: { headers: new Headers() },
    })).rejects.toEqual(expect.objectContaining<Partial<AgentHttpError>>({
      status: 401,
    }));
  });

  it("enables diagnostics only from administrator-controlled monitor metadata", async () => {
    const context = {
      env: { VITE_SUPABASE_URL: "https://example.supabase.co", VITE_SUPABASE_PUBLISHABLE_KEY: "public" },
      request: { headers: new Headers({ authorization: "Bearer token" }) },
    };
    for (const metadata of [
      { user_metadata: { account_purpose: "ai_availability_monitor" } },
      { app_metadata: { account_purpose: "email_delivery_monitor" } },
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "user", ...metadata })));
      expect(await authorizeSupabaseUser(context)).toEqual({ id: "user" });
    }
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      id: "monitor", app_metadata: { account_purpose: "ai_availability_monitor" },
    })));
    expect(await authorizeSupabaseUser(context)).toEqual({ id: "monitor", isAvailabilityMonitor: true });
  });
});
