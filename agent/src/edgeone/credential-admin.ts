import { parseCredentialFile } from "../credentials";
import type { AgentEnvironment } from "../models";
import { createEdgeOneCredentialStore } from "./credential-store";
import type { EdgeOneMessageStore } from "./types";

const MAX_CREDENTIAL_BYTES = 64 * 1024;

export interface CredentialAdminContext {
  agent?: {
    store?: EdgeOneMessageStore;
  };
  env?: AgentEnvironment;
  request: Request;
}

export interface CreateCredentialAdminHandlerOptions {
  createCredentialStore?: typeof createEdgeOneCredentialStore;
}

interface CredentialUpload {
  scope: string;
  provider: string;
  credential: unknown;
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

function parseUpload(value: unknown): CredentialUpload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Credential upload must be an object");
  }
  const upload = value as Partial<CredentialUpload>;
  if (
    typeof upload.scope !== "string"
    || typeof upload.provider !== "string"
    || !("credential" in upload)
  ) {
    throw new Error("Credential scope, provider and value are required");
  }
  return {
    scope: upload.scope,
    provider: upload.provider,
    credential: upload.credential,
  };
}

/**
 * Platform credential administration endpoint.
 *
 * The endpoint and its operator authentication are intentionally not tied to
 * Agent or Codex. Each supported scope/provider pair must still be explicitly
 * allowlisted and validated before it can reach storage.
 */
export function createCredentialAdminHandler(
  options: CreateCredentialAdminHandlerOptions = {},
) {
  return async function onRequest(
    context: CredentialAdminContext,
  ): Promise<Response> {
    if (context.request.method !== "POST") {
      return jsonResponse(405, { error: "Method not allowed" });
    }

    const environment = context.env ?? process.env;
    const adminToken = environment.JOJO_OPERATOR_TOKEN?.trim() ?? "";
    if (adminToken.length < 32) {
      return jsonResponse(503, {
        error: "Credential administration is not configured",
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

    let upload: CredentialUpload;
    let credential;
    try {
      const body = await context.request.text();
      if (new TextEncoder().encode(body).byteLength > MAX_CREDENTIAL_BYTES) {
        return jsonResponse(413, { error: "Credential payload is too large" });
      }
      upload = parseUpload(JSON.parse(body));
      if (upload.scope !== "agent" || upload.provider !== "openai-codex") {
        return jsonResponse(400, {
          error: "Credential scope or provider is not supported",
        });
      }
      credential = parseCredentialFile({
        [upload.provider]: upload.credential,
      })[upload.provider];
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
      await credentials.modify(upload.provider, async () => credential);
      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store" },
      });
    } catch {
      return jsonResponse(503, { error: "Credential storage is unavailable" });
    }
  };
}
