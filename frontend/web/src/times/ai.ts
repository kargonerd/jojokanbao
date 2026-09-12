import type { JojoAssetDescriptor } from "@jojo/content";
import { readerExplanationRequest, type ExplanationRequest } from "@jojo/ui/reader-explanation";
import type { TextAnchor } from "../annotations/types";
import { agentGatewayUrl } from "../api/agentGateway";
import { timesApi, type TimesNewsItem } from "./api";

const AGENT_URL = agentGatewayUrl("/gateway/times/explain");
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 700_000;
const MAX_IMAGE_EDGE = 1_280;
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const COMPLETION_MARKER = "<!-- JOJO_TIMES_COMPLETE -->";

function completedAnswer(value: string): string | null {
  const normalized = value.trimEnd();
  if (!normalized.endsWith(COMPLETION_MARKER)) return null;
  return normalized.slice(0, -COMPLETION_MARKER.length).trimEnd();
}

export interface TimesAgentImage {
  data: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

export interface TimesExplanationMetadata {
  provider?: string;
  model?: string;
  imageCount: number;
}

function articleText(news: TimesNewsItem): string {
  if (!news.content) return "";
  if (news.contentFormat !== "html") return news.content;
  const parsed = new DOMParser().parseFromString(news.content, "text/html");
  return parsed.body.textContent || "";
}

function concise(value: string | null | undefined, limit: number): string {
  return (value || "").replace(/\s+/gu, " ").trim().slice(0, limit);
}

function promptFor(news: TimesNewsItem, anchor: TextAnchor, imageAssets: JojoAssetDescriptor[]): string {
  const imageNotes = imageAssets.map((asset, index) => {
    const description = concise(asset.caption || asset.alt, 240) || "无图片说明";
    return `图片 ${index + 1}：${description}`;
  }).join("\n");
  return `请用通俗的话解释选中文字是什么或是什么意思，补充理解它所需的背景，并说明它与当前语境的关系。

标题：${concise(news.title, 500)}
来源：${concise(news.source.name, 200)}
发布时间：${concise(news.publishedAt, 100)}

选中文字：
${concise(anchor.quote, 3_000)}

选中文字之前：${concise(anchor.prefix, 900)}
选中文字之后：${concise(anchor.suffix, 900)}

文章正文摘录：
${concise(articleText(news), 3_500)}

${imageNotes ? `可选的随文图片上下文（仅在解释选中文字确实需要视觉信息时参考）：\n${imageNotes}` : ""}`.trimEnd().slice(0, 9_800);
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

async function compressedImage(source: Blob): Promise<Blob | null> {
  if (SUPPORTED_IMAGE_TYPES.has(source.type) && source.size <= MAX_IMAGE_BYTES) return source;
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  const bitmap = await createImageBitmap(source);
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.78, 0.64, 0.5]) {
      const output = await canvasBlob(canvas, quality);
      if (output && output.size <= MAX_IMAGE_BYTES) return output;
    }
    return null;
  } finally {
    bitmap.close();
  }
}

async function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const comma = value.indexOf(",");
      if (comma < 0) reject(new Error("图片编码失败"));
      else resolve(value.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function orderedImageAssets(news: TimesNewsItem): JojoAssetDescriptor[] {
  const images = news.assets.filter((asset) => asset.type === "image");
  return [...images].sort((left, right) => Number(right.role === "lead") - Number(left.role === "lead")).slice(0, MAX_IMAGES);
}

export async function prepareTimesAgentImages(
  news: TimesNewsItem,
  signal?: AbortSignal,
): Promise<{ images: TimesAgentImage[]; assets: JojoAssetDescriptor[] }> {
  const prepared: TimesAgentImage[] = [];
  const preparedAssets: JojoAssetDescriptor[] = [];
  for (const asset of orderedImageAssets(news)) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const source = await timesApi.assetObjectBlob(asset, signal);
      const image = await compressedImage(source);
      if (!image || !SUPPORTED_IMAGE_TYPES.has(image.type)) continue;
      prepared.push({
        data: await blobBase64(image),
        mimeType: image.type as TimesAgentImage["mimeType"],
      });
      preparedAssets.push(asset);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      // One corrupt archived image must not block explanation of the text or
      // the remaining images.
    }
  }
  return { images: prepared, assets: preparedAssets };
}

async function accessToken(): Promise<string> {
  const { authClient } = await import("../account/auth");
  const { data, error } = await authClient.auth.getSession();
  if (error) throw error;
  const token = data.session?.access_token;
  if (!token) throw new Error("请先登录后使用 AI 解释");
  return token;
}

export function explainTimesSelection(
  news: TimesNewsItem,
  anchor: TextAnchor,
  callbacks: {
    onStatus(status: string): void;
    onChunk(text: string): void;
    onDone(metadata: TimesExplanationMetadata, answer: string): void;
    onError(message: string): void;
  },
  request: ExplanationRequest = {},
): () => void {
  const controller = new AbortController();
  void (async () => {
    callbacks.onStatus("正在准备阅读上下文…");
    const [token, prepared] = await Promise.all([
      accessToken(),
      prepareTimesAgentImages(news, controller.signal),
    ]);
    if (controller.signal.aborted) return;
    callbacks.onStatus("正在结合文章上下文理解选中文字…");
    const response = await fetch(AGENT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "Makers-Conversation-Id": request.conversationId || `times_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
      },
      body: JSON.stringify({
        ...readerExplanationRequest(promptFor(news, anchor, prepared.assets), request),
        ...(prepared.images.length ? { images: prepared.images } : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(payload.error || `AI 解释服务返回 HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("AI 解释服务没有返回数据");

    const metadata: TimesExplanationMetadata = { imageCount: prepared.images.length };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let answerText = "";
    let receivedDone = false;
    const processFrame = (frame: string): void => {
      if (controller.signal.aborted || receivedDone) return;
      const lines = frame.split("\n");
      const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
      const payloadText = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!payloadText) return;
      const event = JSON.parse(payloadText) as Record<string, unknown>;
      if (eventName === "status") {
        if (typeof event.provider === "string") metadata.provider = event.provider;
        if (typeof event.model === "string") metadata.model = event.model;
        callbacks.onStatus("正在理解选中文字…");
      } else if (eventName === "text_delta" && typeof event.delta === "string") {
        callbacks.onStatus("正在生成解释…");
        answerText += event.delta;
        callbacks.onChunk(event.delta);
      } else if (eventName === "error") {
        throw new Error(typeof event.message === "string" ? event.message : "AI 解释失败");
      } else if (eventName === "done") {
        if (event.stopReason === "length") {
          throw new Error("AI 解释生成到一半就停止了，请重试");
        }
        if (!completedAnswer(answerText)) {
          throw new Error("AI 解释似乎没有生成完整，请重试");
        }
        receivedDone = true;
      }
    };
    try {
      while (!receivedDone && !controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replaceAll("\r\n", "\n");
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";
        for (const frame of frames) processFrame(frame);
        if (receivedDone) break;
      }
      buffer += decoder.decode();
      buffer = buffer.replaceAll("\r\n", "\n");
      for (const frame of buffer.split("\n\n")) {
        if (frame.trim()) processFrame(frame);
        if (receivedDone) break;
      }
      if (!receivedDone) throw new Error("AI 解释连接意外中断，请重试");
      if (!controller.signal.aborted) callbacks.onDone(metadata, completedAnswer(answerText)!);
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  })().catch((error: unknown) => {
    if (controller.signal.aborted) return;
    if (error instanceof DOMException && error.name === "AbortError") return;
    const message = error instanceof Error ? error.message : String(error);
    callbacks.onError(message === "Failed to fetch"
      ? "暂时无法连接 AI 解释服务，请稍后重试"
      : message);
  });
  return () => controller.abort();
}
