import { createEdgeOneAgentHandler } from "@jojo/agent-edgeone";

const handle = createEdgeOneAgentHandler({
  defaultProfile: "international",
});

export async function onRequest(context: Parameters<typeof handle>[0]) {
  return handle(context);
}
