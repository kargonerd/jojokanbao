import { afterEach, expect, it, vi } from "vitest";
import { loginAntigravity } from "../src/antigravity/login";

const callbackServer = vi.hoisted(() => ({ port: 0 }));
vi.mock("node:http", async (importOriginal) => {
  const http = await importOriginal<typeof import("node:http")>();
  return {
    ...http,
    createServer: (...args: Parameters<typeof http.createServer>) => {
      const server = http.createServer(...args);
      const listen = server.listen.bind(server);
      // Exercise real loopback HTTP without occupying a user's live OAuth port.
      server.listen = ((_port: number, host: string, ready: () => void) => listen(0, host, () => {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("No test callback port");
        callbackServer.port = address.port;
        ready();
      })) as typeof server.listen;
      return server;
    },
  };
});

afterEach(() => { vi.unstubAllGlobals(); });

it("completes the package's loopback OAuth login with offline access and writes Pi-compatible metadata", async () => {
  const nativeFetch = globalThis.fetch;
  let callback: Promise<Response> | undefined;
  let oauthUrl: URL | undefined;
  let tokenBody: URLSearchParams | undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);
    if (address.startsWith(`http://127.0.0.1:${callbackServer.port}/`)) return nativeFetch(url, init);
    if (address === "https://oauth2.googleapis.com/token") {
      tokenBody = new URLSearchParams(String(init?.body));
      return Response.json({ access_token: "login-access", refresh_token: "offline-refresh", expires_in: 3600 });
    }
    if (address.includes("userinfo")) return Response.json({ email: "test@example.invalid" });
    if (address.includes("loadCodeAssist")) return Response.json({ cloudaicompanionProject: "login-project" });
    throw new Error(`Unexpected login request: ${address}`);
  }));
  const result = await loginAntigravity({
    onAuth: ({ url }) => {
      oauthUrl = new URL(url);
      const local = new URL(`http://127.0.0.1:${callbackServer.port}/oauth-callback`);
      local.searchParams.set("code", "test-authorization-code");
      local.searchParams.set("state", oauthUrl.searchParams.get("state")!);
      callback = (async () => {
        const stale = new URL(local);
        stale.searchParams.set("state", "previous-login-state");
        expect((await fetch(stale)).status).toBe(400);
        const staleError = new URL(stale);
        staleError.searchParams.set("error", "access_denied");
        expect((await fetch(staleError)).status).toBe(400);
        return fetch(local);
      })();
    },
    onPrompt: () => new Promise(() => undefined),
    onDeviceCode: () => undefined,
    onSelect: async () => undefined,
  });
  expect((await callback)!.status).toBe(200);
  expect(oauthUrl!.searchParams.get("access_type")).toBe("offline");
  expect(oauthUrl!.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/aicode");
  expect(tokenBody!.get("code_verifier")).toBeTruthy();
  expect(tokenBody!.get("code_verifier")).not.toBe(oauthUrl!.searchParams.get("state"));
  expect(result).toMatchObject({ type: "oauth", access: "login-access", refresh: "offline-refresh", projectId: "login-project" });
});
