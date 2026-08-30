import {
  createEdgeOneAgentHandler,
  createRagAgentDefinition,
  createRagTools,
} from "@jojo/agent";

const definition = createRagAgentDefinition();
const handle = createEdgeOneAgentHandler({
  agentId: definition.id,
  systemPrompt: definition.systemPrompt,
  tools(context, _user, body) {
    const environment = context.env ?? process.env;
    return createRagTools({
      contentCdnBase: environment.JOJO_CONTENT_CDN_BASE?.trim() || "https://blacknews.jojokanbao.cn/",
      scope: body.scope,
      focus: body.focus,
    });
  },
});

export async function onRequest(context: Parameters<typeof handle>[0]) {
  return handle(context);
}
