import type { JojoAssetDescriptor } from "@jojo/content";
import { mobileAccessToken, parseAgentSseFrames } from "./bookAgent";
import {
  loadTimesAssetBytes,
  plainTimesArticleText,
  timesSourceName,
  type MobileTimesNewsItem,
} from "./times";

const TIMES_AGENT_URL = process.env.EXPO_PUBLIC_TIMES_AGENT_API_URL?.trim()
  || "https://agent-global.jojokanbao.cn/times";
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 700_000;
const COMPLETION_MARKER = "<!-- JOJO_TIMES_COMPLETE -->";
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export interface MobileTimesTextAnchor {
  quote: string;
  prefix?: string;
  suffix?: string;
}

export interface MobileTimesExplanationMetadata {
  provider?: string;
  model?: string;
  imageCount: number;
}

interface MobileTimesAgentCallbacks {
  onStatus(status: string): void;
  onChunk(text: string): void;
  onDone(metadata: MobileTimesExplanationMetadata, answer: string): void;
  onError(message: string): void;
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += alphabet[first >> 2];
    output += alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)];
    output += second === undefined ? "=" : alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)];
    output += third === undefined ? "=" : alphabet[third & 63];
  }
  return output;
}

function concise(value: string | null | undefined, limit: number): string {
  return (value || "").replace(/\s+/gu, " ").trim().slice(0, limit);
}

function completedAnswer(value: string): string | null {
  const normalized = value.trimEnd();
  if (!normalized.endsWith(COMPLETION_MARKER)) return null;
  return normalized.slice(0, -COMPLETION_MARKER.length).trimEnd();
}

function orderedImages(news: MobileTimesNewsItem): JojoAssetDescriptor[] {
  return news.assets
    .filter((asset) => asset.type === "image" && SUPPORTED_IMAGE_TYPES.has(asset.mediaType))
    .sort((left, right) => Number(right.role === "lead") - Number(left.role === "lead"))
    .slice(0, MAX_IMAGES);
}

function promptFor(news: MobileTimesNewsItem, anchor: MobileTimesTextAnchor, assets: JojoAssetDescriptor[]): string {
  const imageNotes = assets.map((asset, index) => (
    `图片 ${index + 1}：${concise(asset.caption || asset.alt, 240) || "无图片说明"}`
  )).join("\n");
  return `请解释下面新闻中选中的内容。

标题：${concise(news.title, 500)}
来源：${concise(timesSourceName(news.source), 200)}
发布时间：${concise(news.publishedAt, 100)}

选中文字：
${concise(anchor.quote, 3_000)}

选中文字之前：${concise(anchor.prefix, 900)}
选中文字之后：${concise(anchor.suffix, 900)}

文章正文摘录：
${concise(plainTimesArticleText(news.content || "", news.contentFormat), 3_500)}

${imageNotes ? `随文图片说明（图片本身也已作为视觉输入附上）：\n${imageNotes}` : "这篇文章没有可用的随文图片输入。"}`.slice(0, 9_800);
}

async function prepareImages(news: MobileTimesNewsItem, signal: AbortSignal) {
  const images: Array<{ data: string; mimeType: string }> = [];
  const assets: JojoAssetDescriptor[] = [];
  for (const asset of orderedImages(news)) {
    if (signal.aborted) throw new Error("Aborted");
    try {
      const bytes = await loadTimesAssetBytes(asset, signal);
      if (bytes.byteLength > MAX_IMAGE_BYTES) continue;
      images.push({ data: bytesToBase64(bytes), mimeType: asset.mediaType });
      assets.push(asset);
    } catch (error) {
      if (signal.aborted) throw error;
    }
  }
  return { images, assets };
}

export function explainMobileTimesSelection(
  news: MobileTimesNewsItem,
  anchor: MobileTimesTextAnchor,
  callbacks: MobileTimesAgentCallbacks,
): () => void {
  const controller = new AbortController();
  void (async () => {
    callbacks.onStatus("正在准备正文和随文图片…");
    const [token, prepared] = await Promise.all([
      mobileAccessToken(),
      prepareImages(news, controller.signal),
    ]);
    callbacks.onStatus(prepared.images.length
      ? `正在结合 ${prepared.images.length} 张随文图片分析…`
      : "正在结合文章上下文分析…");
    const response = await fetch(TIMES_AGENT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Makers-Conversation-Id": `times_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`,
      },
      body: JSON.stringify({
        message: promptFor(news, anchor, prepared.assets),
        ...(prepared.images.length ? { images: prepared.images } : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(payload.error || `AI 解释服务返回 HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("AI 解释服务没有返回数据");

    const metadata: MobileTimesExplanationMetadata = { imageCount: prepared.images.length };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let answer = "";
    let receivedDone = false;
    const consume = (eventName: string, event: Record<string, unknown>) => {
      if (eventName === "status") {
        if (typeof event.provider === "string") metadata.provider = event.provider;
        if (typeof event.model === "string") metadata.model = event.model;
        callbacks.onStatus("正在理解选中文字与图片…");
      } else if (eventName === "text_delta" && typeof event.delta === "string") {
        callbacks.onStatus("正在生成解释…");
        answer += event.delta;
        callbacks.onChunk(event.delta);
      } else if (eventName === "error") {
        throw new Error(typeof event.message === "string" ? event.message : "AI 解释失败");
      } else if (eventName === "done") {
        if (event.stopReason === "length") throw new Error("AI 解释生成到一半就停止了，请重试");
        receivedDone = true;
      }
    };
    while (!receivedDone) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      buffer = parseAgentSseFrames(buffer, consume);
    }
    buffer += decoder.decode();
    if (buffer.trim()) parseAgentSseFrames(`${buffer}\n\n`, consume);
    const completed = completedAnswer(answer);
    if (!receivedDone || !completed) throw new Error("AI 解释似乎没有生成完整，请重试");
    callbacks.onDone(metadata, completed);
  })().catch((error: unknown) => {
    if (controller.signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    callbacks.onError(message === "Failed to fetch" ? "暂时无法连接 AI 解释服务，请稍后重试" : message);
  });
  return () => controller.abort();
}
