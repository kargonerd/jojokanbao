import { createClient, type SupabaseClient, type SupportedStorage } from "@supabase/supabase-js";
import type { Database } from "./types";

export interface AuthClientOptions {
  supabaseUrl: string;
  publishableKey: string;
  storageKey?: string;
  storage?: SupportedStorage;
  detectSessionInUrl?: boolean;
}

export type JojoAuthClient = SupabaseClient<Database> & {
  createRecoveryClient: () => Pick<SupabaseClient<Database>, "auth">;
};

export function createJojoAuthClient({
  supabaseUrl,
  publishableKey,
  storageKey = "jojo-auth-session",
  storage,
  detectSessionInUrl = true,
}: AuthClientOptions): JojoAuthClient {
  if (!supabaseUrl || !publishableKey) {
    throw new Error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY.");
  }

  const client = createClient<Database>(supabaseUrl, publishableKey, {
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
      auth: {
        storageKey: `${storageKey}-password-recovery`,
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    }),
  });
}
