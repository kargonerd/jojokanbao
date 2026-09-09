import type { OAuthCredential } from "@earendil-works/pi-ai";
import { refreshAntigravityToken } from "pi-antigravity/src/auth/oauth.js";

export class AntigravityRefreshError extends Error {
  constructor() {
    super("Antigravity OAuth refresh failed; retry or sign in again if authorization was revoked");
    this.name = "AntigravityRefreshError";
  }
}

export function antigravityProjectId(credential: OAuthCredential): string {
  if (typeof credential.projectId !== "string" || !credential.projectId.trim()) {
    throw new Error("Antigravity OAuth requires projectId; run auth:antigravity");
  }
  return credential.projectId;
}

export async function refreshAntigravityCredential(
  credential: OAuthCredential,
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  const timeout = AbortSignal.timeout(30_000);
  const refreshSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  refreshSignal.throwIfAborted();
  try {
    antigravityProjectId(credential);
    const refreshed = await refreshAntigravityToken(credential, refreshSignal);
    if (!refreshed.access?.trim() || !refreshed.refresh?.trim()
      || !Number.isFinite(refreshed.expires) || refreshed.expires <= Date.now()) {
      throw new AntigravityRefreshError();
    }
    return { ...credential, ...refreshed, type: "oauth" };
  } catch {
    refreshSignal.throwIfAborted();
    // Never propagate token endpoint payloads into client SSE or operator logs.
    throw new AntigravityRefreshError();
  }
}
