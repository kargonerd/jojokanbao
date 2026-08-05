import { createEdgeOneAgentHandler } from "@jojo/agent";

const handle = createEdgeOneAgentHandler({});

export async function onRequest(context: Parameters<typeof handle>[0]) {
  return handle(context);
}
