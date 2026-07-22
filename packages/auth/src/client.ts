import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";

export interface AuthClientOptions {
  supabaseUrl: string;
  publishableKey: string;
  storageKey?: string;
}

export type JojoAuthClient = SupabaseClient<Database>;

export function createJojoAuthClient({
  supabaseUrl,
  publishableKey,
  storageKey = "jojo-auth-session",
}: AuthClientOptions): JojoAuthClient {
  if (!supabaseUrl || !publishableKey) {
    throw new Error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY.");
  }

  return createClient<Database>(supabaseUrl, publishableKey, {
    auth: {
      storageKey,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "pkce",
    },
  });
}

export function getProfileAvatarUrl(client: JojoAuthClient, avatarPath: string | null | undefined): string | null {
  if (!avatarPath) return null;
  return client.storage.from("avatars").getPublicUrl(avatarPath).data.publicUrl;
}
