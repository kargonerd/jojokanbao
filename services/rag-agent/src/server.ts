import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentConfiguration, runAgent } from "./agent-runner.js";
import { DocumentStore } from "./document-store.js";
import type { ChatRequestBody, ChatStreamEvent } from "./types.js";

const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;

export interface BuildServerOptions {
  store?: DocumentStore;
  logger?: boolean;
}

export async function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 1_000_000 });
  const store = options.store ?? new DocumentStore();
  await store.initialize();

  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
  });
  await app.register(multipart, {
    limits: { files: 1, fileSize: MAX_DOCUMENT_BYTES, fields: 2 },
  });

  app.get("/api/health", async () => ({
    success: true,
    data: { status: "ok", agent: await agentConfiguration() },
  }));

  app.get("/api/documents", async () => ({ success: true, data: await store.list() }));

  app.post("/api/documents", async (request, reply) => {
    try {
      const part = await request.file();
      if (!part) return reply.code(400).send({ success: false, error: "请选择 Markdown 文件" });
      const titleField = part.fields.title;
      const title = titleField && "value" in titleField ? String(titleField.value) : undefined;
      const content = await part.toBuffer();
      const document = await store.add({ originalName: part.filename, content, ...(title ? { title } : {}) });
      return reply.code(201).send({ success: true, data: document });
    } catch (error) {
      const message = error instanceof Error ? error.message : "添加文档失败";
      return reply.code(400).send({ success: false, error: message });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/documents/:id", async (request, reply) => {
    const removed = await store.remove(request.params.id);
    if (!removed) return reply.code(404).send({ success: false, error: "文档不存在" });
    return { success: true };
  });

  app.post<{ Body: ChatRequestBody }>("/api/chat/stream", async (request, reply) => {
    const body = request.body;
    if (!body?.question?.trim()) return reply.code(400).send({ success: false, error: "请输入问题" });
    if (body.question.length > 2_000) return reply.code(400).send({ success: false, error: "问题不能超过 2000 个字符" });
    if (!Array.isArray(body.documentIds) || body.documentIds.length === 0) {
      return reply.code(400).send({ success: false, error: "请至少选择一份文档" });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const abortController = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) abortController.abort();
    });
    const emit = (event: ChatStreamEvent) => {
      if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      await runAgent({
        question: body.question.trim(),
        documentIds: body.documentIds,
        history: Array.isArray(body.history) ? body.history : [],
        store,
        signal: abortController.signal,
        emit,
      });
    } catch (error) {
      if (!abortController.signal.aborted) {
        emit({ type: "error", message: error instanceof Error ? error.message : "问答失败" });
      }
    } finally {
      if (!reply.raw.destroyed) reply.raw.end();
    }
  });

  return app;
}

const isDirectRun = Boolean(process.argv[1]) && resolve(process.argv[1]!) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const app = await buildServer();
  const port = Number(process.env.PORT || 8787);
  await app.listen({ host: "0.0.0.0", port });
}
