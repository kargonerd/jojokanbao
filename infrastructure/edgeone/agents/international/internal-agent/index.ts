import {
  AgentHttpError,
  createEdgeOneAgentHandler,
  createRemoteDocumentTools,
} from "@jojo/agent";

const handle = createEdgeOneAgentHandler({
  tools(context, user, body) {
    if (body.application !== "rag") return [];
    if (!body.rag) throw new AgentHttpError(400, "rag context is required");
    const conversationId = context.conversation_id;
    if (!conversationId) {
      throw new AgentHttpError(400, "conversation id is required");
    }
    return createRemoteDocumentTools({
      conversationId,
      environment: context.env ?? process.env,
      notebookId: body.rag.notebookId,
      sourceIds: body.rag.sourceIds,
      userId: user.id,
    });
  },
});

export async function onRequest(context: Parameters<typeof handle>[0]) {
  return handle(context);
}
