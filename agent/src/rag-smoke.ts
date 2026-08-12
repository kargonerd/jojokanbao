import { fileURLToPath } from "node:url";
import {
  DEFAULT_CODEX_REASONING,
  JsonCredentialStore,
  createPlatformModelRuntime,
  createRagAgentDefinition,
  createRagTools,
  modelRuntimeStream,
  resolvePlatformModelConfig,
  runPlatformAgent,
} from "./index";

const prompt = process.argv.slice(2).join(" ").trim()
  || "《毛泽东自述》的童年时代主要讲了什么？请依据馆藏原文简要回答并注明书名和章节。";
const searchUrl = process.env.JOJO_CONTENT_SEARCH_URL?.trim();
const contentCdnBase = process.env.JOJO_CONTENT_CDN_BASE?.trim();
if (!searchUrl || !contentCdnBase) {
  throw new Error("JOJO_CONTENT_SEARCH_URL and JOJO_CONTENT_CDN_BASE are required");
}

const config = resolvePlatformModelConfig(process.env);
const credentials = new JsonCredentialStore(
  process.env.JOJO_AGENT_AUTH_PATH?.trim()
    || fileURLToPath(new URL("../auth.json", import.meta.url)),
);
const runtime = await createPlatformModelRuntime({ config, environment: process.env, credentials });
if (!runtime.configured) throw new Error(`${config.provider}/${config.model} is not configured`);

const definition = createRagAgentDefinition();
const tools = createRagTools({
  searchUrl,
  contentCdnBase,
  scope: {
    datasetIds: process.env.JOJO_CONTENT_DATASET_ID?.trim()
      ? [process.env.JOJO_CONTENT_DATASET_ID.trim()]
      : undefined,
    itemIds: process.env.JOJO_CONTENT_ITEM_ID?.trim()
      ? [process.env.JOJO_CONTENT_ITEM_ID.trim()]
      : undefined,
  },
});
const toolNames: string[] = [];
const result = await runPlatformAgent({
  systemPrompt: definition.systemPrompt,
  prompt,
  tools,
  model: runtime.model,
  stream: modelRuntimeStream(runtime),
  reasoning: DEFAULT_CODEX_REASONING,
  onEvent(event) {
    if (event.type === "text_delta") process.stdout.write(event.delta);
    if (event.type === "tool_start") {
      toolNames.push(event.name);
      process.stderr.write(`\n[tool] ${event.name}\n`);
    }
  },
});

process.stdout.write(`\n\n${JSON.stringify({
  provider: config.provider,
  model: config.model,
  tools: toolNames,
  turns: result.turns,
  toolCalls: result.toolCalls,
  tokens: result.usage.totalTokens,
  costUsd: result.usage.cost.total,
  durationMs: result.durationMs,
}, null, 2)}\n`);
