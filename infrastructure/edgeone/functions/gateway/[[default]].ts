import { createCredentialAdminHandler } from "@jojo/agent/edgeone/credential-admin";
import { createConversationAdminHandler } from "@jojo/agent/edgeone/conversation-admin";

const handleCredentials = createCredentialAdminHandler();
const handleConversations = createConversationAdminHandler();

type GatewayContext = Parameters<typeof handleCredentials>[0]
  & Parameters<typeof handleConversations>[0];

export async function onRequest(context: GatewayContext): Promise<Response> {
  const pathname = new URL(context.request.url).pathname.replace(/\/+$/, "");
  if (pathname === "/gateway/credentials") {
    return handleCredentials(context);
  }
  if (
    pathname === "/gateway/conversations"
    || pathname.startsWith("/gateway/conversations/")
  ) {
    return handleConversations(context);
  }
  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
