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
const DIRECT_BROKEN_KEY = "jojo-auth-direct-broken-until";
const DIRECT_BROKEN_MS = 10 * 60_000;

// sessionStorage is per tab and survives a reload; it is absent in React
// Native and can throw in private mode, so both helpers stay total.
function readDirectBroken(): number {
  try {
    const until = Number(globalThis.sessionStorage?.getItem(DIRECT_BROKEN_KEY) ?? 0);
    return Number.isFinite(until) ? until : 0;
  } catch {
    return 0;
  }
}

function rememberDirectBroken(until: number): void {
  try {
    globalThis.sessionStorage?.setItem(DIRECT_BROKEN_KEY, String(until));
  } catch {
    // Storage unavailable: fall back to the in-memory value.
  }
}

export function createFallbackFetch(fallbackUrl: string): typeof fetch {
  const base = fallbackUrl.replace(/\/$/, "");
  // Once direct is known to be blocked, stop paying the failed attempt on
  // every request until the block likely clears or the network changes.
  let directBrokenUntil = readDirectBroken();
  const retarget = (input: RequestInfo | URL): RequestInfo | URL => {
    if (typeof input === "string" || input instanceof URL) {
      const url = new URL(input.toString());
      return `${base}${url.pathname}${url.search}`;
    }
    const url = new URL(input.url);
    return new Request(`${base}${url.pathname}${url.search}`, input);
  };
  return async (input, init) => {
    if (Date.now() < directBrokenUntil) return fetch(retarget(input), init);
    try {
      return await fetch(input, init);
    } catch (error) {
      // AbortError (a timeout we own) means the request may have been sent.
      if (!(error instanceof TypeError)) throw error;
      directBrokenUntil = Date.now() + DIRECT_BROKEN_MS;
      rememberDirectBroken(directBrokenUntil);
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
