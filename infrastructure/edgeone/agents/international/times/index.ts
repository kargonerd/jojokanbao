import {
  createEdgeOneAgentHandler,
  createTimesAgentDefinition,
} from "@jojo/agent";

const definition = createTimesAgentDefinition();
const handle = createEdgeOneAgentHandler({
  agentId: definition.id,
  systemPrompt: definition.systemPrompt,
});

export async function onRequest(context: Parameters<typeof handle>[0]) {
  return handle(context);
}
