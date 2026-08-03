import {
  parseCredentialFile,
  type AgentEnvironment,
} from "@jojo/agent-runtime";
import { createEdgeOneCredentialStore } from "./credential-store";
import type { EdgeOneConversationStore } from "./types";

const MAX_CREDENTIAL_BYTES = 64 * 1024;

export interface CodexCredentialAdminContext {
  agent?: {
    store?: EdgeOneConversationStore;
  };
  env?: AgentEnvironment;
  request: Request;
}

export interface CreateCodexCredentialAdminHandlerOptions {
  createCredentialStore?: typeof createEdgeOneCredentialStore;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function secretMatches(provided: string, expected: string): Promise<boolean> {
  const [providedDigest, expectedDigest] = await Promise.all([
    digest(provided),
    digest(expected),
  ]);
  let difference = 0;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    difference |= providedDigest[index]! ^ expectedDigest[index]!;
  }
  return difference === 0;
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
}

/**
 * One-purpose administration endpoint used by the local `auth:push` command.
 *
 * Codex OAuth payloads are larger than the Makers environment-variable limit,
 * so they arrive over TLS and are immediately encrypted into Makers Store. This route
 * never returns or logs credential contents.
 */
export function createCodexCredentialAdminHandler(
  options: CreateCodexCredentialAdminHandlerOptions = {},
) {
  return async function onRequest(
    context: CodexCredentialAdminContext,
  ): Promise<Response> {
    if (context.request.method !== "POST") {
      return jsonResponse(405, { error: "Method not allowed" });
    }

    const environment = context.env ?? process.env;
    const adminToken = environment.CODEX_CREDENTIAL_ADMIN_TOKEN?.trim() ?? "";
    if (adminToken.length < 32) {
      return jsonResponse(503, {
        error: "Codex credential administration is not configured",
      });
    }
    if (!await secretMatches(bearerToken(context.request), adminToken)) {
      return jsonResponse(401, { error: "Authentication required" });
    }

    const declaredLength = Number(
      context.request.headers.get("content-length") ?? "0",
    );
    if (declaredLength > MAX_CREDENTIAL_BYTES) {
      return jsonResponse(413, { error: "Credential payload is too large" });
    }

    let credential;
    try {
      const body = await context.request.text();
      if (new TextEncoder().encode(body).byteLength > MAX_CREDENTIAL_BYTES) {
        return jsonResponse(413, { error: "Credential payload is too large" });
      }
      credential = parseCredentialFile(body)["openai-codex"];
      if (credential?.type !== "oauth") {
        return jsonResponse(400, {
          error: "A valid openai-codex OAuth credential is required",
        });
      }
    } catch {
      return jsonResponse(400, { error: "Credential payload is invalid" });
    }

    try {
      const credentials = (
        options.createCredentialStore ?? createEdgeOneCredentialStore
      )(environment, context.agent?.store);
      await credentials.modify("openai-codex", async () => credential);
      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store" },
      });
    } catch {
      return jsonResponse(503, { error: "Credential storage is unavailable" });
    }
  };
}
