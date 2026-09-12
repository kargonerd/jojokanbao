import { describe, expect, it, vi } from "vitest";
import { Analytics, analyticsHost, eventProperties, isMonitorUser, safeException, screenForPath, type AnalyticsTransport } from "../src/index";
import { sanitizePostHogEvent } from "../src/sanitize";

const context = { client: "desktop" as const, platform: "win32", app_version: "1.0", release_channel: "stable", app_variant: "standard", installation_id: "installation" };
function fixture() {
  const analytics = new Analytics();
  let user: string | undefined;
  const transport: AnalyticsTransport = {
    capture: vi.fn(), exception: vi.fn(), identify: vi.fn((id) => { user = id; }),
    reset: vi.fn(() => { user = undefined; }), identifiedId: () => user, setEnabled: vi.fn(),
  };
  analytics.install(transport, context);
  return { analytics, transport };
}

describe("analytics identity and consent", () => {
  it("reports startup errors after SDK/auth readiness, with private text already removed", () => {
    const { analytics, transport } = fixture();
    analytics.exception(new TypeError("private input"), "react");
    expect(transport.exception).not.toHaveBeenCalled();
    analytics.setIdentity({ initialized: true, userId: null });
    expect(transport.exception).toHaveBeenCalledWith(expect.objectContaining({ name: "TypeError", message: "Application error (message omitted)" }), expect.objectContaining({ error_source: "react" }));
  });
  it("holds early events until auth resolves and identifies before draining", () => {
    const { analytics, transport } = fixture();
    analytics.screen("home"); analytics.setForeground(true);
    expect(transport.capture).not.toHaveBeenCalled();
    analytics.setIdentity({ initialized: true, userId: "reader" });
    expect(transport.identify).toHaveBeenCalledWith("reader");
    expect(vi.mocked(transport.capture).mock.calls.map(([event]) => event)).toEqual(["app_started", "app_active", "screen_viewed"]);
    expect(transport.capture).toHaveBeenLastCalledWith("screen_viewed", { ...context, signed_in: true, screen: "home" });
    analytics.screen("home"); analytics.setIdentity({ initialized: true, userId: "reader" });
    expect(transport.capture).toHaveBeenCalledTimes(3);
  });
  it("discards monitor events, including events buffered before auth", () => {
    const { analytics, transport } = fixture();
    analytics.track("reading_loaded");
    analytics.setIdentity({ initialized: true, userId: "monitor", excluded: true });
    analytics.exception(new Error("secret"), "window"); analytics.track("search_started");
    expect(transport.capture).not.toHaveBeenCalled(); expect(transport.identify).not.toHaveBeenCalled();
    expect(transport.exception).not.toHaveBeenCalled(); expect(transport.setEnabled).toHaveBeenLastCalledWith(false);
    analytics.setIdentity({ initialized: true, userId: "reader" });
    expect(vi.mocked(transport.capture).mock.calls.map(([event]) => event)).toEqual(["app_started"]);
  });
  it("resets on account switches and logout while keeping installation context", () => {
    const { analytics, transport } = fixture();
    analytics.setIdentity({ initialized: true, userId: "first" });
    analytics.setIdentity({ initialized: true, userId: "second" });
    analytics.setIdentity({ initialized: true, userId: null });
    analytics.track("reading_loaded");
    expect(transport.reset).toHaveBeenCalledTimes(2);
    expect(transport.capture).toHaveBeenLastCalledWith("reading_loaded", { ...context, signed_in: false });
  });
  it("opt-out discards queued events and disables the transport, opt-in resumes", () => {
    const { analytics, transport } = fixture();
    analytics.screen("private_screen"); analytics.setConsent(false);
    analytics.setIdentity({ initialized: true, userId: "reader" });
    analytics.track("reading_loaded"); analytics.exception(new Error(), "react");
    expect(transport.capture).not.toHaveBeenCalled(); expect(transport.exception).not.toHaveBeenCalled();
    analytics.setConsent(true); analytics.screen("settings");
    expect(vi.mocked(transport.capture).mock.calls.map(([event]) => event)).toEqual(["app_started", "screen_viewed"]);
    analytics.setConsent(false); expect(transport.setEnabled).toHaveBeenLastCalledWith(false);
  });
  it("does not count background/tray state as active or let reporting failures escape", () => {
    const { analytics, transport } = fixture();
    analytics.setIdentity({ initialized: true, userId: null });
    analytics.setForeground(false); analytics.setForeground(true); analytics.setForeground(true);
    expect(vi.mocked(transport.capture).mock.calls.map(([event]) => event)).toEqual(["app_started", "app_active"]);
    vi.mocked(transport.capture).mockImplementation(() => { throw new Error("offline"); });
    vi.mocked(transport.exception).mockImplementation(() => { throw new Error("offline"); });
    expect(() => { analytics.track("search_failed"); analytics.exception(new Error(), "window"); }).not.toThrow();
  });
});

describe("event privacy contract", () => {
  it("only includes known properties and rejects unbounded or invalid values", () => {
    expect(eventProperties({ query: "secret", screen: "search", duration_ms: Infinity, content_id: "x".repeat(201) })).toEqual({ screen: "search" });
    expect(isMonitorUser({ user_metadata: { account_purpose: "ai_availability_monitor" } })).toBe(true);
    expect(isMonitorUser({ app_metadata: { account_purpose: "email_delivery_monitor" } })).toBe(true);
  });
  it("normalizes routes without leaking URL parameters and validates ingestion hosts", () => {
    expect(screenForPath("/archive/rmrb/20260911?keyword=secret")).toBe("archive_reader");
    expect(screenForPath("/archive/qiushi/202601")).toBe("archive_reader");
    expect(screenForPath("/book/example/private?token=secret")).toBe("book_reader");
    expect(screenForPath("/unknown-secret")).toBe("other");
    expect(analyticsHost("https://us.i.posthog.com/")).toBe("https://us.i.posthog.com");
    for (const host of ["http://bad", "https://user:secret@example.com", "https://example.com/?token=secret", "bad"]) expect(analyticsHost(host)).toBeUndefined();
  });
  it("removes exception messages, source paths, SDK URL fields and person properties", () => {
    const original = new TypeError("secret query");
    original.stack = "TypeError: secret query\n    at read (https://example.com/private/main.js:12:3?token=secret)";
    const safe = safeException(original);
    expect(safe.name).toBe("TypeError"); expect(safe.stack).toContain("main.js:12:3"); expect(safe.stack).not.toContain("secret");
    const event = sanitizePostHogEvent({ $set: { email: "secret" }, properties: {
      token: "phc_test", distinct_id: "reader", $current_url: "secret", $set: { email: "secret" },
      $exception_list: [{ type: "TypeError", value: "secret", stacktrace: { frames: [{ filename: "https://example.com/private/main.js?secret", function: "read", lineno: 12, vars: { password: "secret" } }] } }],
    } });
    expect(event.properties).toMatchObject({ token: "phc_test", distinct_id: "reader" });
    expect(JSON.stringify(event)).not.toContain("secret"); expect(JSON.stringify(event)).not.toContain("example.com");
    expect(JSON.stringify(event)).toContain("main.js");
  });
});
