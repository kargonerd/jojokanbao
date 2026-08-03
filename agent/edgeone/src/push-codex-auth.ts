import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseCredentialFile } from "@jojo/agent-runtime";

const deploymentUrl = process.env.JOJO_AGENT_DEPLOYMENT_URL?.trim();
const adminToken = process.env.CODEX_CREDENTIAL_ADMIN_TOKEN?.trim();
if (!deploymentUrl || !adminToken) {
  throw new Error(
    "JOJO_AGENT_DEPLOYMENT_URL and CODEX_CREDENTIAL_ADMIN_TOKEN are required",
  );
}

const authPath = process.env.JOJO_AGENT_AUTH_PATH?.trim()
  || fileURLToPath(new URL("../../runtime/auth.json", import.meta.url));
const credentials = parseCredentialFile(await readFile(authPath, "utf8"));
const codex = credentials["openai-codex"];
if (codex?.type !== "oauth") {
  throw new Error(`No openai-codex OAuth credential found in ${authPath}`);
}

const target = new URL("/internal/codex-auth", deploymentUrl);
if (target.protocol !== "https:" && target.hostname !== "localhost") {
  throw new Error("JOJO_AGENT_DEPLOYMENT_URL must use HTTPS");
}

const response = await fetch(target, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${adminToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ "openai-codex": codex }),
});
if (!response.ok) {
  const message = await response.text();
  throw new Error(`Codex credential upload failed (${response.status}): ${message}`);
}

process.stdout.write(`Codex OAuth credential uploaded to ${target.origin}\n`);
