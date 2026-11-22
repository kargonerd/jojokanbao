import { createClient, type SupabaseClient, type SupportedStorage } from "@supabase/supabase-js";
import type { Database } from "./types";

export interface AuthClientOptions {
  supabaseUrl: string;
  publishableKey: string;
  /**
   * Same-origin proxy used only when the direct request cannot connect.
   * Mainland carriers reset TLS to *.supabase.co on some routes; the proxy
   * forwards from the cloud function, whose egress is not filtered.
   */
  fallbackUrl?: string;
  storageKey?: string;
  storage?: SupportedStorage;
  detectSessionInUrl?: boolean;
}

export type JojoAuthClient = SupabaseClient<Database> & {
  createRecoveryClient: () => Pick<SupabaseClient<Database>, "auth">;
};

/**
 * Replays a request against `fallbackUrl` when the direct connection fails.
 *
 * Only connection-level failures are retried: a TypeError (no answer, the
 * request never left) is safe to replay, while an abort or timeout may have
 * reached the service and must not be.
 */
const DIRECT_BROKEN_KEY = "jojo-auth-direct-broken";
// The marker only spares repeated failures; a network change clears it sooner,
// so a short lifetime keeps a recovered connection from being avoided for long.
const DIRECT_BROKEN_MS = 5 * 60_000;

interface DirectBrokenMarker {
  until: number;
  network: string;
}

/**
 * Coarse identity of the current connection. A different network means the
 * earlier failure says nothing about this one, which is what lets a reader
 * switch from cellular to Wi-Fi without staying on the proxy until expiry.
 */
function networkSignature(): string {
  const connection = (globalThis.navigator as
    | (Navigator & { connection?: { type?: string; effectiveType?: string } })
    | undefined)?.connection;
  return `${connection?.type ?? ""}|${connection?.effectiveType ?? ""}`;
}

// sessionStorage is per tab and survives a reload; it is absent in React
// Native and can throw in private mode, so these helpers stay total.
function readDirectBroken(): DirectBrokenMarker | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(DIRECT_BROKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DirectBrokenMarker> | null;
    if (typeof parsed?.until !== "number" || typeof parsed.network !== "string") return null;
    return { until: parsed.until, network: parsed.network };
  } catch {
    return null;
  }
}

function rememberDirectBroken(marker: DirectBrokenMarker): void {
  try {
    globalThis.sessionStorage?.setItem(DIRECT_BROKEN_KEY, JSON.stringify(marker));
  } catch {
    // Storage unavailable: fall back to the in-memory value.
  }
}

function clearDirectBroken(): void {
  try {
    globalThis.sessionStorage?.removeItem(DIRECT_BROKEN_KEY);
  } catch {
    // Nothing to clear.
  }
}

export function createFallbackFetch(fallbackUrl: string): typeof fetch {
  const base = fallbackUrl.replace(/\/$/, "");
  // Once direct is known to be blocked, stop paying the failed attempt on
  // every request until the marker expires or the connection changes.
  const stored = readDirectBroken();
  let directBrokenUntil = stored && stored.until > Date.now() && stored.network === networkSignature()
    ? stored.until
    : 0;
  let brokenNetwork = stored?.network ?? "";
  const forget = () => {
    directBrokenUntil = 0;
    clearDirectBroken();
  };
  // A reconnect or a carrier/interface change invalidates the earlier failure.
  if (typeof globalThis.addEventListener === "function") globalThis.addEventListener("online", forget);
  (globalThis.navigator as (Navigator & { connection?: { addEventListener?: (type: string, listener: () => void) => void } }) | undefined)
    ?.connection?.addEventListener?.("change", forget);
  const retarget = (input: RequestInfo | URL): RequestInfo | URL => {
    if (typeof input === "string" || input instanceof URL) {
      const url = new URL(input.toString());
      return `${base}${url.pathname}${url.search}`;
    }
    const url = new URL(input.url);
    return new Request(`${base}${url.pathname}${url.search}`, input);
  };
  return async (input, init) => {
    // Events can be missed (silent carrier switch), so verify the identity too.
    if (directBrokenUntil && (Date.now() >= directBrokenUntil || networkSignature() !== brokenNetwork)) forget();
    if (directBrokenUntil) return fetch(retarget(input), init);
    try {
      return await fetch(input, init);
    } catch (error) {
      // AbortError (a timeout we own) means the request may have been sent.
      if (!(error instanceof TypeError)) throw error;
      brokenNetwork = networkSignature();
      directBrokenUntil = Date.now() + DIRECT_BROKEN_MS;
      rememberDirectBroken({ until: directBrokenUntil, network: brokenNetwork });
      return fetch(retarget(input), init);
    }
  };
}

export function createJojoAuthClient({
  supabaseUrl,
  publishableKey,
  fallbackUrl,
  storageKey = "jojo-auth-session",
  storage,
  detectSessionInUrl = true,
}: AuthClientOptions): JojoAuthClient {
  if (!supabaseUrl || !publishableKey) {
    throw new Error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY.");
  }

  const transport = fallbackUrl ? { fetch: createFallbackFetch(fallbackUrl) } : undefined;
  const client = createClient<Database>(supabaseUrl, publishableKey, {
    global: transport,
    auth: {
      storageKey,
      storage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl,
      flowType: "pkce",
    },
  });
  return Object.assign(client, {
    // Password recovery writes must retain the verified session even when
    // another tab changes the application's persisted login concurrently.
    createRecoveryClient: () => createClient<Database>(supabaseUrl, publishableKey, {
      global: transport,
      auth: {
        storageKey: `${storageKey}-password-recovery`,
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    }),
  });
}
