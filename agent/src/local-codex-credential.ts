import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { parseCredentialFile } from "./credentials";
import type { AgentEnvironment } from "./models";

function jwtExpiry(accessToken: string): number {
  const encoded = accessToken.split(".")[1];
  if (!encoded) throw new Error("Local Codex access token has no expiry");
  const payload = JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  ) as { exp?: unknown };
  if (typeof payload.exp !== "number") {
    throw new Error("Local Codex access token has no expiry");
  }
  return payload.exp * 1_000;
}

export async function loadLocalCodexCredential(
  repositoryRoot: string,
  environment: AgentEnvironment,
): Promise<{ credential: OAuthCredential; source: string }> {
  const agentPath = path.join(repositoryRoot, "agent", "auth.json");
  const configured = environment.JOJO_CODEX_AUTH_PATH?.trim()
    || environment.JOJO_AGENT_AUTH_PATH?.trim();
  const authPath = configured
    ? path.resolve(repositoryRoot, configured)
    : existsSync(agentPath)
      ? agentPath
      : path.join(homedir(), ".codex", "auth.json");
  const parsed = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
  const piCredential = parseCredentialFile(parsed)["openai-codex"];
  if (piCredential?.type === "oauth") {
    return { credential: piCredential, source: authPath };
  }
  const tokens = parsed.tokens && typeof parsed.tokens === "object"
    ? parsed.tokens as Record<string, unknown>
    : {};
  const access = tokens.access_token;
  const refresh = tokens.refresh_token;
  if (typeof access !== "string" || typeof refresh !== "string") {
    throw new Error(`No openai-codex OAuth credential found in ${authPath}`);
  }
  return {
    credential: {
      type: "oauth",
      access,
      refresh,
      expires: jwtExpiry(access),
    },
    source: authPath,
  };
}
