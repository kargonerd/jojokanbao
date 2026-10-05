import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHttpError, authorizeSupabaseUser } from "../src";

const JWT_SECRET = "jwt-secret";
const JWT_BASE_URL = "https://example.supabase.co";

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function signToken(claims: Record<string, unknown>, secret = JWT_SECRET): Promise<string> {
  const encoder = new TextEncoder();
  const head = base64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = base64Url(encoder.encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${head}.${body}`));
  return `${head}.${body}.${base64Url(new Uint8Array(signature))}`;
}

function tokenClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: `${JWT_BASE_URL}/auth/v1`,
    aud: "authenticated",
    sub: "user-123",
    email: "staff@example.com",
    exp: now + 600,
    iat: now,
    app_metadata: { jojo_roles: ["admin"] },
    ...overrides,
  };
}

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

  it("verifies tokens locally and grants admin when a JWT secret is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(authorizeSupabaseUser({
      env: {
        VITE_SUPABASE_URL: JWT_BASE_URL,
        VITE_SUPABASE_PUBLISHABLE_KEY: "publishable",
        SUPABASE_JWT_SECRET: JWT_SECRET,
      },
      request: { headers: new Headers({ authorization: `Bearer ${await signToken(tokenClaims())}` }) },
    })).resolves.toEqual({ id: "user-123", isAdmin: true });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps the availability monitor flag from locally verified tokens", async () => {
    await expect(authorizeSupabaseUser({
      env: {
        VITE_SUPABASE_URL: JWT_BASE_URL,
        VITE_SUPABASE_PUBLISHABLE_KEY: "publishable",
        SUPABASE_JWT_SECRET: JWT_SECRET,
      },
      request: {
        headers: new Headers({
          authorization: `Bearer ${await signToken(tokenClaims({
            app_metadata: { account_purpose: "ai_availability_monitor" },
          }))}`,
        }),
      },
    })).resolves.toEqual({ id: "user-123", isAvailabilityMonitor: true });
  });

  it("rejects locally invalid tokens without contacting Supabase", async () => {
    const context = {
      env: {
        VITE_SUPABASE_URL: JWT_BASE_URL,
        VITE_SUPABASE_PUBLISHABLE_KEY: "publishable",
        SUPABASE_JWT_SECRET: JWT_SECRET,
      },
      request: { headers: new Headers({ authorization: "Bearer token" }) },
    };
    const expired = await signToken(tokenClaims({ exp: Math.floor(Date.now() / 1000) - 120 }));
    const wrongAudience = await signToken(tokenClaims({ aud: "anon" }));
    const wrongIssuer = await signToken(tokenClaims({ iss: "https://evil.example.com/auth/v1" }));
    const wrongSignature = await signToken(tokenClaims(), "attacker-secret");
    for (const token of [expired, wrongAudience, wrongIssuer, wrongSignature, "not-a-jwt"]) {
      await expect(authorizeSupabaseUser({
        ...context,
        request: { headers: new Headers({ authorization: `Bearer ${token}` }) },
      })).rejects.toEqual(expect.objectContaining<Partial<AgentHttpError>>({ status: 401 }));
    }
  });
});
