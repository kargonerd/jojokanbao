import { createJojoAuthClient, createJojoAuthStore } from "@jojo/auth";

export const authClient = createJojoAuthClient({
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
  publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
});

export const { useAuthStore, startAuthSync } = createJojoAuthStore(authClient);

export async function confirmSignupEmail(tokenHash: string): Promise<void> {
  const { error } = await authClient.auth.verifyOtp({
    token_hash: tokenHash,
    type: "email",
  });
  if (error) throw error;
}

export async function resendSignupConfirmation(email: string): Promise<void> {
  const { error } = await authClient.auth.resend({
    type: "signup",
    email,
    options: {
      emailRedirectTo: `${window.location.origin}/account`,
    },
  });
  if (error) throw error;
}
