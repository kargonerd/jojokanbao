import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  DEFAULT_CODEX_REASONING,
  PersistentCredentialStore,
  createPlatformModelRuntime,
  modelRuntimeStream,
  resolvePlatformModelConfig,
  runPlatformAgent,
  type CredentialFile,
} from "./index";

interface CodexCliAuth {
  tokens?: {
    access_token?: string;
    refresh_token?: string;
  };
}

function tokenExpiry(token: string): number {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("Codex access token is not a JWT");
  const decoded = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as { exp?: unknown };
  if (typeof decoded.exp !== "number") {
    throw new Error("Codex access token has no expiry");
  }
  return decoded.exp * 1_000;
}

const question = process.argv.slice(2).join(" ").trim();
if (!question) {
  throw new Error(
    'Usage: pnpm --filter @jojo/agent rag:smoke -- "你的问题"',
  );
}
const authPath = process.env.JOJO_CODEX_CLI_AUTH_PATH?.trim()
  || join(homedir(), ".codex", "auth.json");
const documentPath = process.env.JOJO_RAG_DOCUMENT_PATH?.trim();
if (!documentPath) {
  throw new Error("JOJO_RAG_DOCUMENT_PATH is required");
}
const documentText = await readFile(documentPath, "utf8");
const codexAuth = JSON.parse(await readFile(authPath, "utf8")) as CodexCliAuth;
const access = codexAuth.tokens?.access_token;
const refresh = codexAuth.tokens?.refresh_token;
if (!access || !refresh) {
  throw new Error(`Codex CLI OAuth tokens are missing from ${authPath}`);
}
let stored: CredentialFile = {
  "openai-codex": {
    type: "oauth",
    access,
    refresh,
    expires: tokenExpiry(access),
  },
};
const credentials = new PersistentCredentialStore({
  read: async () => stored,
  write: async (next) => {
    stored = next;
  },
});
const environment = process.env;
const runtime = await createPlatformModelRuntime({
  config: resolvePlatformModelConfig(environment),
  credentials,
  environment,
});
if (!runtime.configured) {
  throw new Error("Codex subscription is not available");
}
const searchParameters = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
});
const searchTool: AgentTool<typeof searchParameters> = {
  name: "search_documents",
  label: "Search documents",
  description: [
    "Search the OCR Markdown with literal text.",
    "Try traditional Chinese variants when simplified terms have no results.",
  ].join(" "),
  parameters: searchParameters,
  execute: async (_callId, args) => {
    const maxResults = args.maxResults ?? 3;
    const matches: Array<{
      source_id: string;
      start: number;
      end: number;
      text: string;
    }> = [];
    const terms = [
      args.query.trim(),
      ...args.query.split(/[\s,，、;；|]+/).filter((term) => term.length >= 2),
    ].filter((term, index, all) => term && all.indexOf(term) === index);
    for (const term of terms) {
      let position = 0;
      while (matches.length < maxResults) {
        const index = documentText.indexOf(term, position);
        if (index < 0) break;
        position = index + Math.max(1, term.length);
        const start = Math.max(0, index - 350);
        const end = Math.min(documentText.length, index + term.length + 350);
        if (matches.some((match) => Math.abs(match.start - start) < 200)) {
          continue;
        }
        matches.push({
          source_id: "shanghai-cultural-revolution-volume-1",
          start,
          end,
          text: documentText.slice(start, end),
        });
      }
      if (matches.length >= maxResults) break;
    }
    const value = {
      query: args.query,
      matches,
      ...(matches.length === 0
        ? { hint: "Try shorter, synonymous, or traditional-Chinese terms." }
        : {}),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(value) }],
      details: value,
    };
  },
};
const readParameters = Type.Object({
  sourceId: Type.String(),
  start: Type.Integer({ minimum: 0 }),
  length: Type.Optional(Type.Integer({ minimum: 1, maximum: 6_000 })),
});
const readTool: AgentTool<typeof readParameters> = {
  name: "read_document",
  label: "Read document",
  description: "Read an exact character range from the OCR Markdown.",
  parameters: readParameters,
  execute: async (_callId, args) => {
    if (args.sourceId !== "shanghai-cultural-revolution-volume-1") {
      throw new Error("Unknown source");
    }
    const start = Math.min(Math.max(0, args.start), documentText.length);
    const end = Math.min(documentText.length, start + (args.length ?? 3_000));
    const value = {
      source_id: args.sourceId,
      start,
      end,
      total_characters: documentText.length,
      text: documentText.slice(start, end),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(value) }],
      details: value,
    };
  },
};
const tools = [searchTool, readTool];
const result = await runPlatformAgent({
  systemPrompt: [
    "你是 JOJO 文档问答 Agent，只能依据所选文档回答。",
    "必须先用 search_documents 检索，再用 read_document 阅读最相关的原文。",
    "优先搜一两个短语，每次最多 3 条；零结果时才换词，通常不超过 3 次搜索。",
    "OCR 文档可能使用繁体；简体提问时主动尝试繁体关键词。",
    "证据不足就明确说不知道，关键结论标注 source_id 和字符区间。",
  ].join("\n"),
  prompt: question,
  tools,
  model: runtime.model,
  stream: modelRuntimeStream(runtime),
  reasoning: DEFAULT_CODEX_REASONING,
  maxTurns: 8,
  maxToolCalls: 8,
  onEvent(event) {
    if (event.type === "tool_start") {
      process.stderr.write(
        `[tool] ${event.name} ${JSON.stringify(event.args)}\n`,
      );
    }
    if (event.type === "text_delta") process.stdout.write(event.delta);
  },
});
process.stdout.write(`\n\n${JSON.stringify({
  usage: result.usage,
  turns: result.turns,
  toolCalls: result.toolCalls,
  durationMs: result.durationMs,
}, null, 2)}\n`);
