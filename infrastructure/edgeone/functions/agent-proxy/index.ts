import {
  onRequest as handleAgentProxyRequest,
  type AgentProxyContext,
} from "./handler";

export type { AgentProxyContext } from "./handler";

export async function onRequest(context: AgentProxyContext): Promise<Response> {
  return handleAgentProxyRequest(context);
}
