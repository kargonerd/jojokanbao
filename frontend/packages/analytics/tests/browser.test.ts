// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
const sdk = vi.hoisted(() => ({
  init: vi.fn(), capture: vi.fn(), identify: vi.fn(), reset: vi.fn(), captureException: vi.fn(),
  get_property: vi.fn(), opt_in_capturing: vi.fn(), opt_out_capturing: vi.fn(),
}));
vi.mock("posthog-js", () => ({ default: sdk }));
const context = { client: "desktop" as const, platform: "win32", app_version: "0.0.8", app_variant: "standard", release_channel: "stable" };
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); localStorage.clear(); delete (window as unknown as Record<string, unknown>).ReactNativeWebView; });

describe("browser initialization", () => {
  it("does not load the SDK without configuration or in development", async () => {
    const { initializeBrowserAnalytics } = await import("../src/browser");
    await initializeBrowserAnalytics({ production: true, context });
    expect(sdk.init).not.toHaveBeenCalled();
  });
  it("avoids counting embedded mobile readers as web users", async () => {
    Object.assign(window, { ReactNativeWebView: { postMessage() {} } });
    const { initializeBrowserAnalytics } = await import("../src/browser");
    await initializeBrowserAnalytics({ token: "phc_test", host: "https://us.i.posthog.com", production: true, context });
    expect(sdk.init).not.toHaveBeenCalled();
  });
  it("respects saved opt-out before the first event and preserves the installation id", async () => {
    localStorage.setItem("jojo.analytics.enabled.v1", "false");
    localStorage.setItem("jojo.analytics.installation.v1", "stable-installation");
    const { initializeBrowserAnalytics, setBrowserAnalyticsEnabled } = await import("../src/browser");
    const { analytics } = await import("../src/index");
    analytics.setIdentity({ initialized: true, userId: null });
    await initializeBrowserAnalytics({ token: "phc_test", host: "https://us.i.posthog.com", production: true, context });
    expect(sdk.capture).not.toHaveBeenCalled(); expect(sdk.opt_out_capturing).toHaveBeenCalled();
    const options = sdk.init.mock.calls[0]![1];
    expect(options).toMatchObject({ autocapture: false, capture_pageview: false, disable_session_recording: true, ip: false });
    expect(options.before_send({ properties: {} })).toBeNull();
    setBrowserAnalyticsEnabled(true);
    expect(sdk.capture).toHaveBeenCalledWith("app_started", expect.objectContaining({ installation_id: "stable-installation" }));
    analytics.exception(new Error("private"), "react");
    expect(sdk.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: "Application error (message omitted)" }), expect.any(Object));
    setBrowserAnalyticsEnabled(false);
    expect(options.before_send({ properties: {} })).toBeNull();
  });
  it("captures manual exceptions with the installed SDK while external script loading is disabled", async () => {
    const { default: posthog } = await vi.importActual<typeof import("posthog-js")>("posthog-js");
    const { safeException } = await import("../src/index");
    const { sanitizePostHogEvent } = await import("../src/sanitize");
    const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
    const client = posthog.init("phc_local_test", {
      api_host: "https://us.i.posthog.com", persistence: "memory", autocapture: false,
      capture_pageview: false, capture_pageleave: false, capture_exceptions: false,
      disable_session_recording: true, disable_external_dependency_loading: true,
      advanced_disable_flags: true, advanced_disable_feature_flags: true, disable_surveys: true, ip: false,
      before_send: (event) => { if (event) events.push(sanitizePostHogEvent(event)); return null; },
    }, "local_exception_test")!;
    const error = new TypeError("private");
    error.stack = "TypeError: private\n    at read (https://example.com/main.js:12:3)";
    client.captureException(safeException(error), context);
    const captured = events.find((event) => event.event === "$exception");
    expect(captured?.properties.$exception_list).toEqual(expect.arrayContaining([expect.objectContaining({ type: "TypeError", value: "Application error (message omitted)" })]));
    expect(JSON.stringify(captured)).not.toContain("private");
    client.opt_out_capturing();
  });
});
