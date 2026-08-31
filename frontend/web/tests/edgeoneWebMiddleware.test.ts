import { describe, expect, it, vi } from "vitest";
import { middleware, sha256Hex } from "../../../infrastructure/edgeone/web-middleware";

const betaUrl = "https://beta.jojokanbao.cn";

async function protectedEnvironment(passphrase = "correct horse battery staple") {
  return {
    JOJO_BETA_ACCESS_MODE: "required",
    JOJO_BETA_ACCESS_PASSWORD_SHA256: await sha256Hex(passphrase),
    JOJO_BETA_SESSION_HOURS: "24",
  };
}

describe("EdgeOne Web beta access middleware", () => {
  it("leaves production unchanged when beta access mode is disabled", async () => {
    const next = vi.fn(() => new Response("production"));
    const response = await middleware({
      request: new Request("https://reader.jojokanbao.cn/"),
      env: {},
      next,
    });

    expect(await response.text()).toBe("production");
    expect(next).toHaveBeenCalledOnce();
  });

  it("fails closed when the beta domain is missing access configuration", async () => {
    const next = vi.fn(() => new Response("public beta"));
    const response = await middleware({
      request: new Request(`${betaUrl}/`),
      env: {},
      next,
    });

    expect(response.status).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it("redirects an unauthenticated page request to the access page", async () => {
    const response = await middleware({
      request: new Request(`${betaUrl}/library`, { headers: { Accept: "text/html" } }),
      env: await protectedEnvironment(),
      next: vi.fn(),
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/__beta/access");
  });

  it("rejects an incorrect passphrase without creating a session", async () => {
    const response = await middleware({
      request: new Request(`${betaUrl}/__beta/access`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "passphrase=wrong",
      }),
      env: await protectedEnvironment(),
      next: vi.fn(),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toContain("通行码不正确");
  });

  it("creates a signed cookie and accepts it on later requests", async () => {
    const passphrase = "a private beta passphrase";
    const environment = await protectedEnvironment(passphrase);
    const login = await middleware({
      request: new Request(`${betaUrl}/__beta/access`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `passphrase=${encodeURIComponent(passphrase)}`,
      }),
      env: environment,
      next: vi.fn(),
    });
    const setCookie = login.headers.get("set-cookie") || "";
    const cookie = setCookie.split(";", 1)[0] || "";

    expect(login.status).toBe(303);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");

    const next = vi.fn(() => new Response("redesign", {
      headers: { "Cache-Control": "public, max-age=3600" },
    }));
    const response = await middleware({
      request: new Request(`${betaUrl}/library`, { headers: { Cookie: cookie } }),
      env: environment,
      next,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("redesign");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects a tampered session cookie", async () => {
    const response = await middleware({
      request: new Request(`${betaUrl}/gateway/ask`, {
        method: "POST",
        headers: { Cookie: "__Host-jojo_beta_access=v1.9999999999." + "0".repeat(64) },
      }),
      env: await protectedEnvironment(),
      next: vi.fn(),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Beta access required" });
  });
});
