import { createCredentialAdminHandler } from "@jojo/agent/edgeone/credential-admin";

const handleCredentials = createCredentialAdminHandler();

type GatewayContext = Parameters<typeof handleCredentials>[0];

export async function onRequest(context: GatewayContext): Promise<Response> {
  const pathname = new URL(context.request.url).pathname.replace(/\/+$/, "");
  if (pathname === "/gateway/credentials") {
    return handleCredentials(context);
  }
  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
