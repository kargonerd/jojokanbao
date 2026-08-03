import { createEdgeOneAgentHealthHandler } from "@jojo/agent-edgeone";

const handle = createEdgeOneAgentHealthHandler();

export async function onRequest(context: Parameters<typeof handle>[0]) {
  return handle(context);
}
