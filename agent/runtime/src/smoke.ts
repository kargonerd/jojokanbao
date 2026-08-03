import { fileURLToPath } from "node:url";
import {
  JsonCredentialStore,
  createPlatformModelRuntime,
  modelRuntimeStream,
  resolvePlatformModelConfig,
  runPlatformAgent,
} from "./index";

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  throw new Error(
    'Usage: pnpm --filter @jojo/agent-runtime smoke -- "你的问题"',
  );
}

const config = resolvePlatformModelConfig(process.env);
const credentials = config.provider === "openai-codex"
  ? new JsonCredentialStore(
    process.env.JOJO_AGENT_AUTH_PATH?.trim()
      || fileURLToPath(new URL("../auth.json", import.meta.url)),
  )
  : undefined;
const runtime = await createPlatformModelRuntime({
  config,
  environment: process.env,
  ...(credentials ? { credentials } : {}),
});

if (!runtime.configured) {
  throw new Error(
    `${config.provider}/${config.model} is not configured. `
    + "Run auth:codex or set the provider API key.",
  );
}

const result = await runPlatformAgent({
  systemPrompt: "你是 JOJO Platform 的连通性测试助手。请简洁、准确地回答。",
  prompt,
  model: runtime.model,
  stream: modelRuntimeStream(runtime),
  reasoning: "low",
  onEvent(event) {
    if (event.type === "text_delta") process.stdout.write(event.delta);
  },
});

process.stdout.write(`\n\n${JSON.stringify({
  provider: config.provider,
  model: config.model,
  tokens: result.usage.totalTokens,
  costUsd: result.usage.cost.total,
  durationMs: result.durationMs,
}, null, 2)}\n`);
