import { createJojoAuthClient, createJojoAuthStore } from "@jojo/auth";

export const featureAdminConfigured = Boolean(
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
);

export const featureAdminAuth = featureAdminConfigured
  ? (() => {
      const client = createJojoAuthClient({
        supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
        publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        storageKey: "jojo-admin-console-session",
      });
      return { client, ...createJojoAuthStore(client) };
    })()
  : null;
