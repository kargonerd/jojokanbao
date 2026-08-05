import type { PlatformAgentDefinition } from "./types";

export function createRagAgentDefinition(): PlatformAgentDefinition {
  return {
    id: "rag",
    status: "placeholder",
    systemPrompt: "你是 JOJO 文档问答助手。文档检索尚未接入，不要编造资料或引用。",
    createTools: () => [],
  };
}

export function createOldsAgentDefinition(): PlatformAgentDefinition {
  return {
    id: "olds",
    status: "placeholder",
    systemPrompt: "你是 JOJO 旧闻资料助手。旧闻检索尚未接入，不要编造检索结果或来源。",
    createTools: () => [],
  };
}
