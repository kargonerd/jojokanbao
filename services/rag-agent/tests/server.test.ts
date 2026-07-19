import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentStore } from "../src/document-store.js";
import { buildServer } from "../src/server.js";

describe("RAG agent HTTP API", () => {
  let directory: string;
  let store: DocumentStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "jojo-rag-api-"));
    store = new DocumentStore(directory);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("reports health and returns documents", async () => {
    await store.add({ originalName: "sample.md", content: Buffer.from("# 示例\n\n正文") });
    const app = await buildServer({ store, logger: false });

    const health = await app.inject({ method: "GET", url: "/api/health" });
    const documents = await app.inject({ method: "GET", url: "/api/documents" });

    expect(health.statusCode).toBe(200);
    expect(health.json().data.status).toBe("ok");
    expect(documents.json().data).toHaveLength(1);
    await app.close();
  });

  it("rejects chat without a selected document", async () => {
    const app = await buildServer({ store, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      payload: { question: "作者是谁？", documentIds: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("至少选择一份文档");
    await app.close();
  });
});
