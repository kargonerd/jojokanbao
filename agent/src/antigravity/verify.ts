import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { JsonCredentialStore } from "../credentials";
import { resolveLocalAgentAuthPath } from "../local-codex-credential";
import { createPlatformModelRuntime, modelRuntimeStream, resolvePlatformModelConfig } from "../models";
import { runPlatformAgent } from "../runtime";
import { refreshAntigravityCredential } from "./auth";

// Explicit live verification: refresh now, reopen storage, then exercise tools.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const authPath = resolveLocalAgentAuthPath(root, process.env);
const credentials = new JsonCredentialStore(authPath);
const signal = AbortSignal.timeout(120_000);
await credentials.modify("antigravity", async (current) => {
  if (current?.type !== "oauth") throw new Error("Run auth:antigravity first");
  return refreshAntigravityCredential(current, signal);
}, { signal });
process.stdout.write("OAuth refresh and credential persistence: OK\n");
const config = resolvePlatformModelConfig({
  ...process.env, JOJO_AGENT_PROVIDER: "antigravity",
  JOJO_AGENT_MODEL: process.argv.slice(2).filter((arg) => arg !== "--")[0] || undefined,
});
const runtime = await createPlatformModelRuntime({ config, credentials: new JsonCredentialStore(authPath) });
const discovery = await runtime.models.refresh({ providers: ["antigravity"], force: true, signal });
if (discovery.errors.size) process.stdout.write("Model discovery unavailable; using package catalog.\n");
else process.stdout.write(`Model catalog: ${runtime.models.getModels("antigravity").map((model) => model.id).join(", ")}\n`);
const result = await runPlatformAgent({
  systemPrompt: "你是连通性测试助手。必须调用 read_probe 工具，从工具结果读取验证码并原样回答，不要猜测。",
  prompt: "调用 read_probe，然后告诉我返回的验证码。",
  tools: [{
    name: "read_probe", label: "Read probe", description: "Read the verification code", parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "JOJO-ANTIGRAVITY-OK" }], details: {} }),
  }],
  model: runtime.model, stream: modelRuntimeStream(runtime), reasoning: "low", signal, maxTurns: 3,
  onEvent: (event) => {
    if (event.type === "text_delta") process.stdout.write(event.delta);
    if (event.type === "tool_start") process.stdout.write(`\n[tool] ${event.name}\n`);
  },
});
if (!result.toolCalls || !result.answer.includes("JOJO-ANTIGRAVITY-OK")) {
  throw new Error("Live verification did not complete the expected tool round trip");
}
process.stdout.write(`\n${JSON.stringify({ provider: config.provider, model: config.model, toolCalls: result.toolCalls, tokens: result.usage.totalTokens, durationMs: result.durationMs })}\n`);
