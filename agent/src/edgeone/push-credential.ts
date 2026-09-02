import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseCredentialFile } from "../credentials";

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
const credentials = parseCredentialFile(await readFile(authPath, "utf8"));
const codex = credentials["openai-codex"];
if (codex?.type !== "oauth") {
  throw new Error(`No openai-codex OAuth credential found in ${authPath}`);
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
    provider: "openai-codex",
    credential: codex,
  }),
});
if (!response.ok) {
  const message = await response.text();
  throw new Error(
    `Credential upload failed (${response.status}): ${message}`,
  );
}

process.stdout.write(`Credential uploaded to ${target.origin}\n`);
