const configuredGatewayBase = import.meta.env.VITE_AGENT_GATEWAY_BASE?.trim().replace(/\/$/u, "");

export type AgentGatewayPath = "/gateway/ask" | "/gateway/times/explain" | "/api/v1/speech" | "/api/v1/speech/providers";

export function agentGatewayUrl(
  path: AgentGatewayPath,
  gatewayBase = configuredGatewayBase,
): string {
  return gatewayBase ? `${gatewayBase}${path}` : path;
}
