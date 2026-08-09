import {
  handleAgentProxyRequest,
} from "@jojo/agent/edgeone/proxy";

export async function onRequest(
  context: Parameters<typeof handleAgentProxyRequest>[0],
): Promise<Response> {
  return handleAgentProxyRequest(context);
}
