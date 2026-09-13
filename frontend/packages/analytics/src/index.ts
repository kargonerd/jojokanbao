/** Shared event contract. No browser or native SDK is imported by this entry. */
export type AnalyticsEvent = "app_started" | "app_active" | "screen_viewed" | "reading_loaded"
  | "reading_failed" | "search_started" | "search_completed" | "search_failed" | "download_clicked"
  | "update_available" | "update_downloaded" | "update_failed";
export type Properties = Record<string, string | number | boolean>;
export interface AnalyticsContext extends Properties {
  client: "web" | "desktop" | "mobile" | "homepage";
  platform: string;
  app_version: string;
  release_channel: string;
  app_variant: string;
}
export interface AnalyticsTransport {
  capture(event: string, properties: Properties): void;
  identify(id: string): void;
  reset(): void;
  identifiedId(): string | undefined;
  setEnabled?(enabled: boolean): void;
  exception(error: Error, properties: Properties): void;
}
export interface AnalyticsIdentity {
  initialized: boolean;
  userId: string | null;
  excluded?: boolean;
}

export const propertyNames = new Set([
  "screen", "content_type", "content_id", "duration_ms", "result_count", "page", "outcome",
  "target_platform", "available_version", "error_source", "referrer_host",
]);
export function eventProperties(input: Properties): Properties {
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => propertyNames.has(key)
    && (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
      || (typeof value === "string" && value.length <= 200))));
}

export function isMonitorUser(user: { app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> } | null | undefined): boolean {
  return [user?.app_metadata?.account_purpose, user?.user_metadata?.account_purpose]
    .some((purpose) => purpose === "ai_availability_monitor" || purpose === "email_delivery_monitor");
}

/** Error text is deliberately omitted: it can contain queries, quotes or model output. */
export function safeException(reason: unknown): Error {
  const original = reason instanceof Error ? reason : undefined;
  const name = original?.name && /^[A-Za-z][A-Za-z0-9_.]{0,60}$/.test(original.name) ? original.name : "Error";
  const error = new Error("Application error (message omitted)");
  error.name = name;
  if (original?.stack) {
    const frames = original.stack.split("\n").slice(1)
      .filter((line) => /^\s*at\s/.test(line) || /@.*:\d/.test(line)).slice(0, 25)
      .map((line) => line
        .replace(/(?:https?:\/\/|file:\/\/\/)[^\s)]+/g, (location) => {
          const match = /([^/\\?#]+\.(?:[cm]?js|tsx?|bundle))(?::\d+){0,2}/.exec(location.split(/[?#]/)[0] ?? "");
          return match?.[0] ?? "[source]";
        })
        .replace(/(?:[A-Za-z]:\\|\/(?:Users|home)\/)[^\s)]+/g, "[local source]")
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"));
    error.stack = `${name}: ${error.message}\n${frames.join("\n")}`;
  }
  return error;
}

export function analyticsHost(value: string | undefined): string | undefined {
  try {
    const url = new URL(value || "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
    return url.href.replace(/\/$/, "");
  } catch { return undefined; }
}

export function screenForPath(path: string): string {
  const clean = path.split(/[?#]/)[0] || "/";
  if (/^\/archive\/[^/]+\/\d{6}(?:\d{2})?\/?$/.test(clean)) return "archive_reader";
  if (/^\/book\//.test(clean)) return "book_reader";
  if (/^\/articles\/[^/]+/.test(clean)) return "article";
  if (/^\/times\/.+/.test(clean)) return "times_detail";
  if (/^\/rag(?:\/|$)/.test(clean)) return "ai";
  if (/^\/library(?:\/|$)/.test(clean)) return "library";
  const known: Record<string, string> = {
    "/": "home", "/archive": "archive", "/search": "search", "/archive/search": "search",
    "/account": "account", "/account/confirm": "account_confirmation", "/account/times-sources": "times_settings",
    "/download": "download", "/download/iphone": "iphone_install", "/settings": "settings",
    "/support": "support", "/archive/support": "support", "/notifications": "notifications",
    "/bookshelf": "bookshelf", "/times": "times", "/about": "about", "/articles": "articles",
  };
  return known[clean.replace(/\/$/, "") || "/"] ?? "other";
}

export class Analytics {
  private transport?: AnalyticsTransport;
  private context?: AnalyticsContext;
  private identity: AnalyticsIdentity = { initialized: false, userId: null };
  private consent = true;
  private pending: Array<{ event: AnalyticsEvent; properties: Properties }> = [];
  private pendingErrors: Array<{ error: Error; source: string }> = [];
  private started = false;
  private lastScreen = "";
  private foreground = false;
  private get ready() { return Boolean(this.transport && this.context && this.identity.initialized); }
  get enabled() { return this.ready && this.consent && !this.identity.excluded; }

  install(transport: AnalyticsTransport, context: AnalyticsContext) {
    this.transport = transport;
    this.context = context;
    this.synchronize();
  }

  setIdentity(identity: AnalyticsIdentity) {
    const changed = this.identity.userId !== identity.userId || this.identity.excluded !== identity.excluded;
    if (this.identity.initialized && changed) {
      this.pending = [];
      this.pendingErrors = [];
      this.lastScreen = "";
    }
    this.identity = identity;
    if (identity.excluded) { this.pending = []; this.pendingErrors = []; }
    this.synchronize();
  }

  setConsent(enabled: boolean) {
    this.consent = enabled;
    if (!enabled) { this.pending = []; this.pendingErrors = []; this.lastScreen = ""; }
    this.synchronize();
  }

  private synchronize() {
    if (!this.ready) return;
    try {
      const previous = this.transport!.identifiedId();
      const next = this.consent && !this.identity.excluded ? this.identity.userId : null;
      if (previous && previous !== next) this.transport!.reset();
      this.transport!.setEnabled?.(this.enabled);
      if (!this.enabled) return;
      if (next && next !== this.transport!.identifiedId()) this.transport!.identify(next);
      if (!this.started) {
        this.started = true;
        this.track("app_started");
        if (this.foreground) this.track("app_active");
      }
      const events = this.pending.splice(0);
      for (const { event, properties } of events) this.track(event, properties);
      for (const { error, source } of this.pendingErrors.splice(0)) this.exception(error, source);
    } catch { /* Analytics must never break authentication or rendering. */ }
  }

  track(event: AnalyticsEvent, properties: Properties = {}) {
    if (!this.consent || this.identity.excluded) return;
    if (!this.ready) {
      if (this.pending.length < 50) this.pending.push({ event, properties: eventProperties(properties) });
      return;
    }
    try { this.transport!.capture(event, { ...eventProperties(properties), ...this.context!, signed_in: Boolean(this.identity.userId) }); }
    catch { /* Best effort. */ }
  }

  screen(screen: string) {
    if (screen === this.lastScreen || !this.consent || this.identity.excluded) return;
    this.lastScreen = screen;
    this.track("screen_viewed", { screen });
  }

  setForeground(active: boolean) {
    if (this.foreground === active) return;
    this.foreground = active;
    if (active && this.started) this.track("app_active");
  }

  exception(reason: unknown, source: string) {
    if (!this.consent || this.identity.excluded) return;
    if (!this.ready) {
      if (this.pendingErrors.length < 5) this.pendingErrors.push({ error: safeException(reason), source });
      return;
    }
    try { this.transport!.exception(safeException(reason), { ...this.context!, error_source: source }); }
    catch { /* Error reporting must not throw. */ }
  }
}

export const analytics = new Analytics();

/** One opening, with at most one load and one failure; rerenders cannot inflate counts. */
export function createReadingAttempt(contentType: "book" | "periodical", contentId: string) {
  const start = Date.now();
  let loaded = false;
  let failed = false;
  const properties = () => ({ content_type: contentType, content_id: contentId, duration_ms: Math.max(0, Date.now() - start) });
  return {
    loaded() { if (!loaded) { loaded = true; analytics.track("reading_loaded", properties()); } },
    failed() { if (!failed) { failed = true; analytics.track("reading_failed", properties()); } },
  };
}
