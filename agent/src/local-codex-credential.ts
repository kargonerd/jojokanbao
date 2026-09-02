import path from "node:path";
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
): string {
  const configured = environment.JOJO_CODEX_AUTH_PATH?.trim()
    || environment.JOJO_AGENT_AUTH_PATH?.trim();
  return configured
    ? path.resolve(repositoryRoot, configured)
    : path.join(repositoryRoot, "agent", "auth.json");
}
