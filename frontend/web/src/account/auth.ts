import {
  createJojoAuthClient,
  createJojoAuthStore,
  createPersonalInvitationRepository,
} from "@jojo/auth";

export const authClient = createJojoAuthClient({
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
  publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
});

export const { useAuthStore, startAuthSync } = createJojoAuthStore(authClient);
export const personalInvitations =
  createPersonalInvitationRepository(authClient);
