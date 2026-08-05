import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { AgentEnvironment } from "../models";
import { createAgentServiceSignatureHeaders } from "./service-auth";

const CONVERSATION_HEADER = "Makers-Conversation-Id";
const MAX_TOOL_RESPONSE_CHARACTERS = 30_000;

export interface RemoteDocumentToolOptions {
  conversationId: string;
  environment: AgentEnvironment;
  notebookId: string;
  sourceIds: string[];
  userId: string;
}

function endpoint(environment: AgentEnvironment): URL {
  const configured = environment.JOJO_PLATFORM_API_URL?.trim();
  if (!configured) {
    throw new Error("JOJO_PLATFORM_API_URL is not configured");
  }
  const base = new URL(configured.endsWith("/") ? configured : `${configured}/`);
  if (base.protocol !== "https:" && base.hostname !== "localhost") {
    throw new Error("JOJO_PLATFORM_API_URL must use HTTPS");
  }
  return new URL("v1/internal/rag/documents", base);
}

async function requestDocumentTool(
  options: RemoteDocumentToolOptions,
  operation: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const body = {
    user_id: options.userId,
    notebook_id: options.notebookId,
    source_ids: options.sourceIds,
    ...operation,
  };
  const headers = await createAgentServiceSignatureHeaders({
    body,
    conversationId: options.conversationId,
    environment: options.environment,
    method: "POST",
  });
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  headers.set(CONVERSATION_HEADER, options.conversationId);
  const response = await fetch(endpoint(options.environment), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Document service returned HTTP ${response.status}`);
  }
  return response.json();
}

function toolResult(value: unknown) {
  const text = JSON.stringify(value);
  return {
    content: [{
      type: "text" as const,
      text: text.length > MAX_TOOL_RESPONSE_CHARACTERS
        ? `${text.slice(0, MAX_TOOL_RESPONSE_CHARACTERS)}…`
        : text,
    }],
    details: value,
  };
}

export function createRemoteDocumentTools(
  options: RemoteDocumentToolOptions,
): AgentTool[] {
  const searchParameters = Type.Object({
    query: Type.String({
      description: "Literal words or phrases to find in the selected documents",
    }),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
  });
  const search: AgentTool<typeof searchParameters> = {
    name: "search_documents",
    label: "Search documents",
    description: [
      "Search selected source documents without embeddings.",
      "Use short literal phrases. For OCR or traditional-Chinese documents,",
      "try variant characters, names, dates, and synonyms in separate calls.",
    ].join(" "),
    parameters: searchParameters,
    execute: async (_callId, args, signal) => toolResult(
      await requestDocumentTool(options, {
        operation: "search",
        query: args.query,
        max_results: args.maxResults ?? 3,
      }, signal),
    ),
  };

  const readParameters = Type.Object({
    sourceId: Type.String(),
    start: Type.Integer({ minimum: 0 }),
    length: Type.Optional(Type.Integer({ minimum: 1, maximum: 6_000 })),
  });
  const read: AgentTool<typeof readParameters> = {
    name: "read_document",
    label: "Read document",
    description: "Read an exact character range from a selected source document.",
    parameters: readParameters,
    execute: async (_callId, args, signal) => toolResult(
      await requestDocumentTool(options, {
        operation: "read",
        source_id: args.sourceId,
        start: args.start,
        length: args.length ?? 3_000,
      }, signal),
    ),
  };

  return [search, read];
}
