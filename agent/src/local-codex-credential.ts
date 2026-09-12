import path from "node:path";
import { existsSync } from "node:fs";
import type { AgentEnvironment } from "./models";

/**
 * Return the application-owned Pi credential file.
 *
 * A rotating refresh token must not be borrowed from ~/.codex/auth.json: Codex
 * and this Agent would become two independent writers for the same token.
 */
export function resolveLocalAgentAuthPath(
  repositoryRoot: string,
  environment: AgentEnvironment,
  fallbackRepositoryRoot?: string,
): string {
  const configured = environment.JOJO_CODEX_AUTH_PATH?.trim()
    || environment.JOJO_AGENT_AUTH_PATH?.trim();
  if (configured) return path.resolve(repositoryRoot, configured);
  const localPath = path.join(repositoryRoot, "agent", "auth.json");
  if (!existsSync(localPath) && fallbackRepositoryRoot) {
    const fallbackPath = path.join(fallbackRepositoryRoot, "agent", "auth.json");
    if (existsSync(fallbackPath)) return fallbackPath;
  }
  return localPath;
}
