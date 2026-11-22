import { afterEach, describe, expect, it, vi } from "vitest";
import { createFallbackFetch, createJojoAuthClient } from "../src/client";

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
describe("connection fallback", () => {
  it("keeps the direct connection when it answers", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("{}", { status: 200 });
    }));

    const transport = createFallbackFetch("https://reader.example/api/supabase");
    const response = await transport("https://project.supabase.co/auth/v1/token?grant_type=password", { method: "POST" });

    expect(response.status).toBe(200);
    expect(calls).toEqual(["https://project.supabase.co/auth/v1/token?grant_type=password"]);
  });

  it("replays a connection failure through the proxy, keeping path and query", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (calls.length === 1) throw new TypeError("Failed to fetch");
      return new Response("{}", { status: 200 });
    }));

    const transport = createFallbackFetch("https://reader.example/api/supabase/");
    await transport("https://project.supabase.co/auth/v1/signup?redirect_to=x", { method: "POST" });

    expect(calls).toEqual([
      "https://project.supabase.co/auth/v1/signup?redirect_to=x",
      "https://reader.example/api/supabase/auth/v1/signup?redirect_to=x",
    ]);
  });

  it("does not replay a request that was aborted", async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    vi.stubGlobal("fetch", fetchMock);

    const transport = createFallbackFetch("https://reader.example/api/supabase");

    await expect(transport("https://project.supabase.co/auth/v1/user")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops retrying direct for a while after one failure", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (calls.length === 1) throw new TypeError("Failed to fetch");
      return new Response("{}", { status: 200 });
    }));

    const transport = createFallbackFetch("https://reader.example/api/supabase");
    await transport("https://project.supabase.co/auth/v1/user");
    await transport("https://project.supabase.co/rest/v1/profiles");

    expect(calls).toEqual([
      "https://project.supabase.co/auth/v1/user",
      "https://reader.example/api/supabase/auth/v1/user",
      "https://reader.example/api/supabase/rest/v1/profiles",
    ]);
  });

  it("remembers a broken direct path across reloads", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (calls.length === 1) throw new TypeError("Failed to fetch");
      return new Response("{}", { status: 200 });
    }));

    const first = createFallbackFetch("https://reader.example/api/supabase");
    await first("https://project.supabase.co/auth/v1/user");

    // A new transport stands in for a page reload: the marker is in storage.
    const second = createFallbackFetch("https://reader.example/api/supabase");
    await second("https://project.supabase.co/rest/v1/profiles");

    expect(calls).toEqual([
      "https://project.supabase.co/auth/v1/user",
      "https://reader.example/api/supabase/auth/v1/user",
      "https://reader.example/api/supabase/rest/v1/profiles",
    ]);
  });

  it("re-probes direct once the connection changes", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    });
    vi.stubGlobal("navigator", { connection: { type: "cellular", effectiveType: "4g" } });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (calls.length === 1) throw new TypeError("Failed to fetch");
      return new Response("{}", { status: 200 });
    }));

    await createFallbackFetch("https://reader.example/api/supabase")("https://project.supabase.co/auth/v1/user");

    // Same reader, now on Wi-Fi: the earlier failure says nothing about this link.
    vi.stubGlobal("navigator", { connection: { type: "wifi", effectiveType: "4g" } });
    await createFallbackFetch("https://reader.example/api/supabase")("https://project.supabase.co/rest/v1/profiles");

    expect(calls).toEqual([
      "https://project.supabase.co/auth/v1/user",
      "https://reader.example/api/supabase/auth/v1/user",
      "https://project.supabase.co/rest/v1/profiles",
    ]);
  });

  it("expires the marker so a recovered connection is tried again", async () => {
    vi.useFakeTimers();
    try {
      const store = new Map<string, string>();
      vi.stubGlobal("sessionStorage", {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
        removeItem: (key: string) => { store.delete(key); },
      });
      const calls: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        if (calls.length === 1) throw new TypeError("Failed to fetch");
        return new Response("{}", { status: 200 });
      }));

      await createFallbackFetch("https://reader.example/api/supabase")("https://project.supabase.co/auth/v1/user");
      expect(calls).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await createFallbackFetch("https://reader.example/api/supabase")("https://project.supabase.co/rest/v1/profiles");

      expect(calls.at(-1)).toBe("https://project.supabase.co/rest/v1/profiles");
    } finally {
      vi.useRealTimers();
    }
  });
});
