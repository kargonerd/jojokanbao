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
export const personalInvitationRepository =
  createPersonalInvitationRepository(authClient);

export interface SignupConfirmation {
  displayName: string | null;
}

async function getReaderDisplayName(userId: string): Promise<string | null> {
  const { data, error } = await authClient
    .from("profiles")
    .select("display_name")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.display_name?.trim() || null;
}

export async function getCurrentReaderDisplayName(): Promise<string | null> {
  const { data, error } = await authClient.auth.getUser();
  if (error) throw error;
  if (!data.user) return null;
  return getReaderDisplayName(data.user.id);
}

export async function confirmSignupEmail(
  tokenHash: string,
): Promise<SignupConfirmation> {
  const { data, error } = await authClient.auth.verifyOtp({
    token_hash: tokenHash,
    type: "email",
  });
  if (error) throw error;
  if (!data.user) throw new Error("Email confirmation did not return a user.");

  let displayName: string | null = null;
  try {
    displayName = await getReaderDisplayName(data.user.id);
  } catch {
    // Email verification has succeeded. The confirmation page can retry the
    // profile lookup without incorrectly reporting that the link was invalid.
  }

  return {
    displayName,
  };
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
