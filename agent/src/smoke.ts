import { fileURLToPath } from "node:url";
import {
  DEFAULT_CODEX_REASONING,
  JsonCredentialStore,
  createPlatformModelRuntime,
  modelRuntimeStream,
  resolvePlatformModelConfig,
  runPlatformAgent,
} from "./index";

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  throw new Error(
    'Usage: pnpm --filter @jojo/agent smoke -- "你的问题"',
  );
}

const config = resolvePlatformModelConfig(process.env);
const credentials = new JsonCredentialStore(
  process.env.JOJO_AGENT_AUTH_PATH?.trim()
    || fileURLToPath(new URL("../auth.json", import.meta.url)),
);
const runtime = await createPlatformModelRuntime({
  config,
  environment: process.env,
  credentials,
});

if (!runtime.configured) {
  throw new Error(
    `${config.provider}/${config.model} is not configured. Run auth:codex first.`,
  );
}

const result = await runPlatformAgent({
  systemPrompt: "你是 JOJO 看报的连通性测试助手。请简洁、准确地回答。",
  prompt,
  model: runtime.model,
  stream: modelRuntimeStream(runtime),
  reasoning: DEFAULT_CODEX_REASONING,
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
