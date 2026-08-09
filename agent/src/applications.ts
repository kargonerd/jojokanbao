import type { PlatformAgentDefinition } from "./types";

export function createRagAgentDefinition(): PlatformAgentDefinition {
  return {
    id: "rag",
    status: "available",
    systemPrompt: `你是 JOJO 馆藏研究助手。回答馆藏相关问题必须先用 search_content 查找原文证据。
普通问题读取命中的少量章节即可；考虑扫描全本时，必须先调用 inspect_item 查看章节数、预计处理量和预算。
只有跨章节归纳、全书统计、需要核对全局上下文，而且 inspect_item 表明未超预算时，才调用 scan_full_item。
scan_full_item 下载全本到工具侧并在本地扫描，但不会把全书直接塞进上下文。引用时写明 Dataset、Item 和章节标题。
如果检索不到或证据不足，要明确说明，不要依据常识伪造馆藏内容。`,
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
