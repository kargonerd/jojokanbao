import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseCredentialFile } from "../credentials";
import { isAgentProvider, resolvePlatformModelConfig } from "../models";

const deploymentUrl = process.env.JOJO_CREDENTIAL_SERVICE_URL?.trim();
const operatorToken = process.env.JOJO_OPERATOR_TOKEN?.trim();
if (!deploymentUrl || !operatorToken) {
  throw new Error(
    "JOJO_CREDENTIAL_SERVICE_URL and JOJO_OPERATOR_TOKEN are required",
  );
}

const authPath = process.env.JOJO_CODEX_AUTH_PATH?.trim()
  || process.env.JOJO_AGENT_AUTH_PATH?.trim()
  || fileURLToPath(new URL("../../auth.json", import.meta.url));
const provider = process.argv.slice(2).filter((arg) => arg !== "--")[0]
  ?? resolvePlatformModelConfig(process.env).provider;
if (!isAgentProvider(provider)) throw new Error(`Unsupported Agent provider: ${provider}`);
const credentials = parseCredentialFile(await readFile(authPath, "utf8"));
const credential = credentials[provider];
if (credential?.type !== "oauth") {
  throw new Error(`No ${provider} OAuth credential found in ${authPath}`);
}

const target = new URL("/gateway/credentials", deploymentUrl);
if (target.protocol !== "https:" && target.hostname !== "localhost") {
  throw new Error("JOJO_CREDENTIAL_SERVICE_URL must use HTTPS");
}

const response = await fetch(target, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${operatorToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    scope: "agent",
    provider,
    credential,
  }),
});
if (!response.ok) {
  const message = await response.text();
  throw new Error(
    `Credential upload failed (${response.status}): ${message}`,
  );
}

process.stdout.write(`${provider} credential uploaded to ${target.origin}\n`);
