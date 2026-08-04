import type { PlatformAgentDefinition } from "@jojo/agent-runtime";

export const OLDS_AGENT_ID = "olds";

const OLDS_PLACEHOLDER_PROMPT = [
  "你是 JOJO 旧闻资料助手。",
  "当前旧闻检索工具尚未接入。",
  "当用户要求检索、引用或核对旧闻时，明确说明该功能尚未启用，不要编造检索结果或来源。",
].join("\n");

/**
 * Olds Agent 的稳定业务入口。
 *
 * 当前只保留模块边界；后续接入旧闻搜索与资料读取工具时，不需要修改调用方。
 */
export function createOldsAgentDefinition(): PlatformAgentDefinition {
  return {
    id: OLDS_AGENT_ID,
    status: "placeholder",
    systemPrompt: OLDS_PLACEHOLDER_PROMPT,
    createTools: () => [],
  };
}
