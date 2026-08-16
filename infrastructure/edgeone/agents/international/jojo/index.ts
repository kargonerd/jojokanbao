import {
  createEdgeOneAgentHandler,
  createRagAgentDefinition,
  createRagTools,
  type RagScope,
} from "@jojo/agent";

function scopeFrom(value: unknown): RagScope {
  if (!value || typeof value !== "object") return {};
  const scope = (value as { scope?: unknown }).scope;
  if (!scope || typeof scope !== "object") return {};
  const input = scope as { datasetIds?: unknown; itemIds?: unknown; manifestObjects?: unknown };
  const strings = (candidate: unknown) => Array.isArray(candidate)
    ? candidate.filter((item): item is string => typeof item === "string").slice(0, 100)
    : undefined;
  return {
    datasetIds: strings(input.datasetIds),
    itemIds: strings(input.itemIds),
    manifestObjects: strings(input.manifestObjects),
  };
}

const definition = createRagAgentDefinition();
const handle = createEdgeOneAgentHandler({
  systemPrompt: definition.systemPrompt,
  tools(context) {
    const environment = context.env ?? process.env;
    const searchUrl = environment.JOJO_CONTENT_SEARCH_URL?.trim();
    return createRagTools({
      searchUrl,
      contentCdnBase: environment.JOJO_CONTENT_CDN_BASE?.trim() || "https://blacknews.jojokanbao.cn/",
      scope: scopeFrom(context.request.body),
    });
  },
});

export async function onRequest(context: Parameters<typeof handle>[0]) {
  return handle(context);
}
