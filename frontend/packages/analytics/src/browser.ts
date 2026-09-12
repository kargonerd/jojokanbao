import { analytics, analyticsHost, screenForPath, type AnalyticsContext } from "./index";
import { sanitizePostHogEvent } from "./sanitize";
import { browserAnalyticsEnabled, subscribeBrowserAnalytics } from "./preferences";
export { browserAnalyticsEnabled, setBrowserAnalyticsEnabled, subscribeBrowserAnalytics } from "./preferences";

let started = false;

export async function initializeBrowserAnalytics(options: {
  token?: string; host?: string; production: boolean; context: AnalyticsContext;
}): Promise<void> {
  if (started) return;
  started = true;
  const host = analyticsHost(options.host);
  const nativeReader = /JOJOKanbaoMobile\//i.test(navigator.userAgent)
    || "ReactNativeWebView" in window || "__jojoNativeReaderBridge" in window;
  if (!options.production || !options.token?.trim() || !host || nativeReader) {
    analytics.setConsent(false);
    return;
  }
  analytics.setConsent(browserAnalyticsEnabled());
  subscribeBrowserAnalytics(() => analytics.setConsent(browserAnalyticsEnabled()));
  try {
    const { default: posthog } = await import("posthog-js");
    posthog.init(options.token.trim(), {
      api_host: host,
      persistence: "localStorage",
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_exceptions: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_external_dependency_loading: true,
      advanced_disable_feature_flags: true,
      advanced_disable_flags: true,
      person_profiles: "identified_only",
      ip: false,
      before_send: (event) => event && analytics.enabled ? sanitizePostHogEvent(event) : null,
    });
    let installationId = localStorage.getItem("jojo.analytics.installation.v1");
    if (!installationId) {
      installationId = crypto.randomUUID();
      localStorage.setItem("jojo.analytics.installation.v1", installationId);
    }
    let sdkEnabled: boolean | undefined;
    analytics.install({
      capture: (event, properties) => { posthog.capture(event, properties); },
      identify: (id) => posthog.identify(id),
      identifiedId: () => posthog.get_property("$user_id") as string | undefined,
      reset: () => posthog.reset(),
      setEnabled: (enabled) => {
        if (enabled === sdkEnabled) return;
        sdkEnabled = enabled;
        if (enabled) posthog.opt_in_capturing({ captureEventName: false });
        else posthog.opt_out_capturing();
      },
      exception: (error, properties) => { posthog.captureException(error, properties); },
    }, { ...options.context, installation_id: installationId });
    const foreground = () => analytics.setForeground(document.visibilityState === "visible" && document.hasFocus());
    document.addEventListener("visibilitychange", foreground);
    window.addEventListener("focus", foreground);
    window.addEventListener("blur", foreground);
    foreground();
    window.addEventListener("error", (event) => analytics.exception(event.error, "window"));
    window.addEventListener("unhandledrejection", (event) => analytics.exception(event.reason, "promise"));
    if (options.context.client === "homepage") {
      analytics.setIdentity({ initialized: true, userId: null });
      analytics.screen(screenForPath(location.pathname));
    }
  } catch { /* An unavailable SDK must never stop the application. */ }
}
