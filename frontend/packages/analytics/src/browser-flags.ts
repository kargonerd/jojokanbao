import { analyticsHost } from "./index";
import { flagStorageNamespace, flagValues, type FlagSession } from "./flags";

/** A separate, account-bound SDK instance: analytics opt-out/reset cannot erase rollout caches. */
export async function openBrowserFlagSession(options: {
  token?: string; host?: string; userId: string;
}): Promise<FlagSession> {
  const token = options.token?.trim();
  const host = analyticsHost(options.host);
  if (!token || !host) throw new Error("PostHog feature flag configuration missing");
  const { PostHog } = await import("posthog-js");
  const client = new PostHog();
  const namespace = flagStorageNamespace(token, host, options.userId);
  client.init(token, {
    api_host: host,
    persistence: "localStorage",
    persistence_name: namespace,
    opt_out_capturing_cookie_prefix: namespace,
    bootstrap: { distinctID: options.userId, isIdentifiedID: true },
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
  client.setPersonPropertiesForFlags({ signed_in: true, account_id: options.userId }, false);
  const cached = () => flagValues(client.featureFlags.getFlagVariants());
  return {
    cached,
    subscribe: (listener) => client.onFeatureFlags((_keys, _values, context) => {
      if (!context?.errorsLoading) listener(cached());
    }),
    refresh: () => client.reloadFeatureFlags(),
    dispose: () => { client.set_config({ advanced_disable_flags: true }); },
  };
}
