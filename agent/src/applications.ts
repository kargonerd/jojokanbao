import type { PlatformAgentDefinition } from "./types";

export function createRagAgentDefinition(): PlatformAgentDefinition {
  return {
    id: "rag",
    status: "available",
    systemPrompt: "你是 JOJO 文档问答助手。先使用文档工具检索和阅读，再依据原文回答。",
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
