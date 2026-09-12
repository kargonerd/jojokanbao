import { propertyNames } from "./index";

const sdkProperties = new Set([
  "token", "distinct_id", "$device_id", "$user_id", "$anon_distinct_id", "$session_id", "$window_id",
  "$lib", "$lib_version", "$is_identified", "$process_person_profile", "$geoip_disable",
  "$exception_list", "$exception_fingerprint", "$exception_level", "$exception_type",
  "client", "platform", "app_version", "release_channel", "app_variant", "signed_in", "installation_id",
  ...propertyNames,
]);

/** Last boundary, including properties added by the SDK itself. */
export function sanitizePostHogEvent<T extends { properties?: Record<string, unknown>; $set?: unknown; $set_once?: unknown }>(event: T): T {
  const properties = Object.fromEntries(Object.entries(event.properties ?? {}).filter(([key]) => sdkProperties.has(key)));
  if (Array.isArray(properties.$exception_list)) {
    properties.$exception_list = properties.$exception_list.slice(0, 5).map((exception: unknown) => {
      if (!exception || typeof exception !== "object") return {};
      const item = exception as Record<string, unknown>;
      const trace = item.stacktrace as { frames?: Array<Record<string, unknown>> } | undefined;
      return {
        type: typeof item.type === "string" && /^[A-Za-z][A-Za-z0-9_.]{0,60}$/.test(item.type) ? item.type : "Error",
        value: "Application error (message omitted)",
        stacktrace: { frames: trace?.frames?.slice(-25).map((frame) => ({
          filename: typeof frame.filename === "string" ? frame.filename.split(/[?#]/)[0]?.split(/[/\\]/).pop()?.slice(0, 120) : undefined,
          function: typeof frame.function === "string" && /^[A-Za-z0-9_.$ <>\[\]-]{1,100}$/.test(frame.function) ? frame.function : undefined,
          lineno: typeof frame.lineno === "number" ? frame.lineno : undefined,
          colno: typeof frame.colno === "number" ? frame.colno : undefined,
        })) ?? [] },
      };
    });
  }
  return { ...event, $set: undefined, $set_once: undefined, properties };
}
