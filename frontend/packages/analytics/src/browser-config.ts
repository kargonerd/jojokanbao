import { analyticsHost } from "./index";
import { configStorageNamespace, type ConfigSession } from "./config";

/** Public configuration is independent of analytics consent and account sessions. */
interface BrowserConfigOptions { token?: string; host?: string }
async function browserConfigClient(options: BrowserConfigOptions) {
  const token = options.token?.trim();
  const host = analyticsHost(options.host || "https://us.i.posthog.com");
  if (!token || !host) throw new Error("PostHog configuration missing");
  const { PostHog } = await import("posthog-js");
  const client = new PostHog();
  const namespace = configStorageNamespace(token, host);
  client.init(token, {
    api_host: host,
    persistence: "localStorage",
    persistence_name: namespace,
    opt_out_capturing_cookie_prefix: namespace,
    bootstrap: { distinctID: "jojo-public-config", isIdentifiedID: false },
    autocapture: false, capture_pageview: false, capture_pageleave: false,
    save_campaign_params: false, save_referrer: false,
    capture_exceptions: false, disable_session_recording: true, disable_surveys: true,
    disable_external_dependency_loading: true,
    advanced_disable_feature_flags_on_first_load: true,
    feature_flag_request_timeout_ms: 10_000,
    person_profiles: "never", ip: false,
    // Do not set cache TTL/fresh reads: slow or offline refreshes keep the persisted values.
    before_send: () => null,
  });
  client.setPersonPropertiesForFlags({ signed_in: false }, false);
  return client;
}

/** Public, global config needs no login and is independent of analytics consent. */
export async function openBrowserConfigSession(options: { token?: string; host?: string; key: string }): Promise<ConfigSession> {
  const client = await browserConfigClient(options);
  const cached = () => client.getFeatureFlagPayload(options.key);
  return {
    cached,
    subscribe: (listener) => client.onFeatureFlags((_keys, _values, context) => {
      if (!context?.errorsLoading) listener(cached());
    }),
    refresh: () => client.reloadFeatureFlags(),
    dispose: () => client.set_config({ advanced_disable_flags: true }),
  };
}
