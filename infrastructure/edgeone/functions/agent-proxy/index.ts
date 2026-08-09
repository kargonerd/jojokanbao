import {
  handleAgentProxyRequest,
  type AgentProxyContext,
} from "@jojo/agent/edgeone/proxy";

export type { AgentProxyContext } from "@jojo/agent/edgeone/proxy";

export async function onRequest(context: AgentProxyContext): Promise<Response> {
  return handleAgentProxyRequest(context);
}
