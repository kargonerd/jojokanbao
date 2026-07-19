import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { DocumentStore } from "./document-store.js";

const MAX_SEARCH_OUTPUT_CHARS = 10_000;

export function serializeEvidence(metadata: Record<string, string | number>, content: string): string {
  return JSON.stringify({
    kind: "document_evidence",
    trust: "untrusted",
    metadata,
    content,
  });
}

export function createDocumentTools(store: DocumentStore, allowedDocumentIds: ReadonlySet<string>): AgentTool[] {
  const searchParameters = Type.Object({
    queries: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 6 }),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
  });
  const searchTool: AgentTool<typeof searchParameters, { hitCount: number; returnedCount: number }> = {
    name: "search_document",
    label: "搜索原文",
    description: "在当前允许访问的 Markdown 文档中搜索一个或多个关键词，返回命中位置附近的带行号原文。简体和繁体会统一后匹配。",
    parameters: searchParameters,
    execute: async (_toolCallId, params) => {
      const hits = await store.search([...allowedDocumentIds], params.queries, params.maxResults ?? 5);
      const evidence: string[] = [];
      let outputCharacters = 0;
      for (const hit of hits) {
        const block = serializeEvidence(
          {
            document_id: hit.documentId,
            title: hit.documentTitle,
            lines: `${hit.startLine}-${hit.endLine}`,
            matched: hit.matchedQueries.join(","),
          },
          hit.excerpt,
        );
        if (outputCharacters + block.length > MAX_SEARCH_OUTPUT_CHARS) break;
        evidence.push(block);
        outputCharacters += block.length;
      }
      const body = evidence.length
        ? evidence.join("\n")
        : "没有找到匹配内容。请更换人物、事件、组织或原文可能使用的近义词继续搜索。";
      return {
        content: [{ type: "text", text: body }],
        details: { hitCount: hits.length, returnedCount: evidence.length },
      };
    },
  };

  const readParameters = Type.Object({
    documentId: Type.String({ minLength: 1 }),
    startLine: Type.Integer({ minimum: 1 }),
    endLine: Type.Integer({ minimum: 1 }),
  });
  const readTool: AgentTool<
    typeof readParameters,
    { documentId: string; startLine: number; endLine: number }
  > = {
    name: "read_lines",
    label: "阅读原文",
    description: "按行号读取当前文档中的连续原文。仅在搜索结果表明该段相关时使用；单次最多 200 行。",
    parameters: readParameters,
    execute: async (_toolCallId, params) => {
      if (!allowedDocumentIds.has(params.documentId)) throw new Error("不允许访问当前问答范围之外的文档");
      const records = await store.requireRecords([params.documentId]);
      const record = records[0];
      if (!record) throw new Error("文档不存在");
      const effectiveEndLine = Math.min(params.endLine, record.lineCount);
      const text = await store.readLines(params.documentId, params.startLine, effectiveEndLine);
      return {
        content: [
          {
            type: "text",
            text: serializeEvidence(
              {
                document_id: record.id,
                title: record.title,
                lines: `${params.startLine}-${effectiveEndLine}`,
              },
              text,
            ),
          },
        ],
        details: { documentId: record.id, startLine: params.startLine, endLine: effectiveEndLine },
      };
    },
  };

  return [searchTool, readTool];
}
