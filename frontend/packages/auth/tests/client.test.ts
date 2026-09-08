import { afterEach, describe, expect, it, vi } from "vitest";
import { createJojoAuthClient } from "../src/client";

afterEach(() => vi.unstubAllGlobals());

describe("recovery session isolation", () => {
  it("keeps password and logout requests on the verified account after the persisted login switches", async () => {
    const tokenFor = (id: string) => [
      btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })),
      btoa(JSON.stringify({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600 })),
      btoa("offline-test-signature"),
    ].map((part) => part.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")).join(".");
    const tokenA = tokenFor("reader-a");
    const tokenB = tokenFor("reader-b");
    const requests: Array<{ path: string; method: string; token: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      if (parsed.origin !== "https://recovery-test.supabase.co") throw new Error("Unexpected network destination");
      const token = new Headers(init.headers).get("authorization");
      requests.push({ path: `${parsed.pathname}${parsed.search}`, method: init.method ?? "GET", token });
      if (parsed.pathname === "/auth/v1/logout") return new Response("{}", { status: 200 });
      if (parsed.pathname !== "/auth/v1/user") throw new Error("Unexpected auth operation");
      return new Response(JSON.stringify({ id: token === `Bearer ${tokenA}` ? "reader-a" : "reader-b", aud: "authenticated", email: "reader@example.com" }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const storage = new Map<string, string>();
    const client = createJojoAuthClient({
      supabaseUrl: "https://recovery-test.supabase.co", publishableKey: "offline-test-key", detectSessionInUrl: false,
      storage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); }, removeItem: (key) => { storage.delete(key); } },
    });
    const recovery = client.createRecoveryClient();
    try {
      expect((await recovery.auth.setSession({ access_token: tokenA, refresh_token: "refresh-a" })).error).toBeNull();
      expect((await client.auth.setSession({ access_token: tokenB, refresh_token: "refresh-b" })).error).toBeNull();
      expect((await recovery.auth.updateUser({ password: "new-password" })).error).toBeNull();
      expect((await recovery.auth.signOut({ scope: "others" })).error).toBeNull();
      expect(requests.filter((request) => request.method !== "GET")).toEqual([
        { path: "/auth/v1/user", method: "PUT", token: `Bearer ${tokenA}` },
        { path: "/auth/v1/logout?scope=others", method: "POST", token: `Bearer ${tokenA}` },
      ]);
      expect((await client.auth.getSession()).data.session?.user.id).toBe("reader-b");
      expect([...storage.keys()]).toEqual(["jojo-auth-session"]);
    } finally {
      await client.auth.dispose();
      await recovery.auth.dispose();
    }
  });
});
