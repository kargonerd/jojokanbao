import type { PlatformAgentDefinition } from "@jojo/agent-runtime";

export const RAG_AGENT_ID = "rag";

const RAG_PLACEHOLDER_PROMPT = [
  "你是 JOJO 文档问答助手。",
  "当前文档检索工具尚未接入。",
  "当用户要求根据资料回答、引用原文或定位出处时，明确说明该功能尚未启用，不要编造文档内容或引用。",
].join("\n");

/**
 * RAG Agent 的稳定业务入口。
 *
 * 当前只保留模块边界；后续接入文档读取、搜索或引用工具时，不需要修改调用方。
 */
export function createRagAgentDefinition(): PlatformAgentDefinition {
  return {
    id: RAG_AGENT_ID,
    status: "placeholder",
    systemPrompt: RAG_PLACEHOLDER_PROMPT,
    createTools: () => [],
  };
}
