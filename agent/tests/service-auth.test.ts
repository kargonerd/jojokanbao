import { describe, expect, it } from "vitest";
import {
  authorizeAgentServiceRequest,
  createAgentServiceSignatureHeaders,
} from "../src";

const environment = {
  JOJO_AGENT_SERVICE_SECRET: "0123456789abcdef0123456789abcdef",
};
const now = 1_800_000_000_000;

async function signedContext(input: {
  body?: unknown;
  nonce: string;
  timestamp?: number;
}) {
  const conversationId = "conversation-001";
  const method = "POST";
  const headers = await createAgentServiceSignatureHeaders({
    body: input.body,
    conversationId,
    environment,
    method,
    nonce: input.nonce,
    now: input.timestamp ?? now,
  });
  return {
    env: environment,
    conversation_id: conversationId,
    request: {
      body: input.body,
      headers,
      method,
    },
  };
}

describe("Agent service authentication", () => {
  it("matches the Python backend signature fixture", async () => {
    const headers = await createAgentServiceSignatureHeaders({
      body: {
        application: "rag",
        message: "你好",
        rag: { notebookId: "book", sourceIds: ["source"] },
        systemPrompt: "只依据原文",
        userId: "user-1",
      },
      conversationId: "conversation-001",
      environment,
      method: "POST",
      nonce: "nonce_0000000000000000000099",
      now: 1_800_000_000_000,
    });

    expect(headers.get("X-JOJO-Service-Signature")).toBe(
      "9UvMA80GDuJnyan_xsFDM9NjEg7MG7WJBplc-G91XDY",
    );
  });

  it("accepts a fresh Cloud Function signature", async () => {
    const context = await signedContext({
      body: { z: 1, message: "你好", a: true },
      nonce: "nonce_0000000000000000000001",
    });
    context.request.body = { message: "你好", a: true, z: 1 };

    await expect(authorizeAgentServiceRequest(context, { now }))
      .resolves.toBeUndefined();
  });

  it("rejects a tampered request body", async () => {
    const context = await signedContext({
      body: { message: "原始问题" },
      nonce: "nonce_0000000000000000000002",
    });
    context.request.body = { message: "篡改后的问题" };

    await expect(authorizeAgentServiceRequest(context, { now }))
      .rejects.toMatchObject({
        status: 401,
        message: "Trusted service authentication required",
      });
  });

  it("rejects expired signatures", async () => {
    const context = await signedContext({
      body: { message: "你好" },
      nonce: "nonce_0000000000000000000003",
      timestamp: now - 61_000,
    });

    await expect(authorizeAgentServiceRequest(context, { now }))
      .rejects.toMatchObject({ status: 401 });
  });

  it("rejects a replayed nonce in the same runtime", async () => {
    const context = await signedContext({
      body: { message: "你好" },
      nonce: "nonce_0000000000000000000004",
    });

    await authorizeAgentServiceRequest(context, { now });
    await expect(authorizeAgentServiceRequest(context, { now }))
      .rejects.toMatchObject({ status: 401 });
  });
});
