export const SPEECH_VOICES = [
  { id: "male", label: "男声" },
  { id: "female", label: "女声" },
] as const;

export type SpeechVoice = string;

export function speechVoiceLabel(voice: string, provider: string, providers: readonly SpeechProvider[] = []): string {
  return providers.find((item) => item.id === provider)?.voices.find((item) => item.id === voice)?.label
    ?? SPEECH_VOICES.find((item) => item.id === voice)?.label ?? "选择声音";
}

export interface SpeechProvider {
  id: string;
  label: string;
  description: string;
  available: boolean;
  cacheVersion?: string;
  streaming?: boolean;
  voices: Array<{ id: string; label: string; description: string }>;
}

export interface SpeechCapabilities {
  defaultProvider: string;
  defaultVoice?: string;
  cdnBase?: string | null;
  requiresAuth: boolean;
  providers: SpeechProvider[];
}

export const DEFAULT_SPEECH_PROVIDERS: SpeechProvider[] = [{
  id: "auto", label: "在线朗读", description: "", available: true,
  cacheVersion: "two-voices-v1",
  voices: SPEECH_VOICES.map((voice) => ({ ...voice, description: "" })),
}];

export function logicalSpeechVoice(voice?: string): "male" | "female" {
  return voice === "female" || ["冰糖", "茉莉", "zh-CN-XiaoxiaoNeural", "zh-CN-XiaoyiNeural"].includes(voice || "") ? "female" : "male";
}

export interface SpeechSource { url: string; duration: number; streaming?: boolean; expiresAt?: number }
export type SpeechScope = "book" | "news";
export interface SpeechClientConfig {
  allowed: () => boolean;
  apiUrl: (path: "/api/v1/speech" | "/api/v1/speech/providers") => string;
  digest: (text: string) => Promise<string>;
}

export function createSpeechClient(config: SpeechClientConfig) {
  async function loadSpeechProviders(signal?: AbortSignal): Promise<SpeechCapabilities> {
    if (!config.allowed()) throw new Error("请先登录并开通听读功能");
    const response = await fetch(`${config.apiUrl("/api/v1/speech/providers")}?v=2`, { signal: signal ?? null });
    if (!response.ok) throw new Error("无法加载声音列表，请重试");
    const data: SpeechCapabilities = await response.json();
    if (!Array.isArray(data.providers) || !data.providers.every((provider) =>
      typeof provider.id === "string" && typeof provider.available === "boolean" &&
      Array.isArray(provider.voices) && provider.voices.every((voice) => typeof voice.id === "string" && typeof voice.label === "string"))) {
      throw new Error("声音列表格式不正确，请重试");
    }
    return data;
  }



  function responseError(payload: unknown, status: number): string {
    if (payload && typeof payload === "object") {
      const error = (payload as { error?: unknown }).error;
      if (error && typeof error === "object") {
        const value = error as { code?: unknown; message?: unknown };
        if (value.code === "unauthorized") return "请先登录后使用听读";
        if (typeof value.message === "string") return value.message;
      }
    }
    return `语音生成失败（HTTP ${status}）`;
  }

  async function requestSpeech(
    text: string,
    voice: SpeechVoice,
    signal?: AbortSignal,
    options: { provider: string; cacheVersion?: string; cdnBase?: string | null; scope?: SpeechScope; streaming?: boolean } = { provider: "auto" },
  ): Promise<Blob | SpeechSource> {
    // The product intentionally uses a soft client-side gate, not media authorization.
    if (!config.allowed()) throw new Error("请先登录并开通听读功能");
    if (options.cdnBase && options.cacheVersion) {
      const key = await speechKey(options.provider, options.cacheVersion, voice, text);
      const base = `${options.cdnBase.replace(/\/$/u, "")}/${speechObjectBase(options.provider, key, options.scope)}`;
      const cached = await fetchSpeechMetadata(`${base}.json`, signal, 1500).catch((error: unknown) => {
        if (signal?.aborted) throw error;
        return null;
      });
      if (cached?.ok) {
        const source = validateSpeechSource(cached.record, options.cdnBase, key, options.scope);
        if (source) return source;
      }
      // The backend checks the authoritative B2 object again; CDN misses/errors do
      // not themselves authorize duplicate synthesis.
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const endpoint = config.apiUrl("/api/v1/speech");
    const response = await fetch(`${endpoint}${options.streaming ? "?stream=true" : ""}`, {
      method: "POST",
      signal: signal ?? null,
      headers,
      body: JSON.stringify({ text, voice, provider: options.provider, ...(options.scope === "news" ? { scope: "news" } : {}) }),
    });
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      throw new Error(responseError(payload, response.status));
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.startsWith("application/json") && options.cdnBase) {
      const record: unknown = await response.json();
      if (options.streaming && record && typeof record === "object" && "formatVersion" in record && record.formatVersion === "jojo-speech-stream/1") {
        const stream = record as { ticket?: unknown; expiresAt?: unknown };
        if (typeof stream.ticket !== "string" || !/^[A-Za-z0-9_=-]{80,8192}$/u.test(stream.ticket) ||
          typeof stream.expiresAt !== "number" || !Number.isFinite(stream.expiresAt) || stream.expiresAt <= Date.now() / 1000) {
          throw new Error("语音服务返回了无效音频地址");
        }
        // Construct the media URL ourselves. Audio elements and native players
        // can consume a progressive GET without downloading a complete Blob.
        return { url: `${endpoint}/stream?ticket=${encodeURIComponent(stream.ticket)}`, duration: 0,
          streaming: true, expiresAt: stream.expiresAt };
      }
      const key = options.cacheVersion ? await speechKey(options.provider, options.cacheVersion, voice, text) : undefined;
      const source = validateSpeechSource(record, options.cdnBase, key, options.scope);
      if (!source) throw new Error("语音服务返回了无效音频地址");
      return source;
    }
    if (!contentType.startsWith("audio/")) throw new Error("语音服务返回了无效内容");
    return response.blob();
  }



  async function fetchSpeechMetadata(url: string, signal?: AbortSignal, timeoutMs = 6000): Promise<{ ok: boolean; record: unknown }> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      // Keep the deadline active until the small metadata body has arrived.
      const record: unknown = response.ok ? await response.json().catch(() => null) : null;
      return { ok: response.ok, record };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  /** Read-only metadata warming: never synthesizes missing parts. */
  async function loadCachedSpeechDurations(
    texts: string[], voice: string, signal: AbortSignal,
    options: { provider: string; cacheVersion: string; cdnBase: string; scope?: SpeechScope },
  ): Promise<Record<number, number>> {
    if (!config.allowed()) return {};
    const known: Record<number, number> = {};
    let cursor = 0;
    // Cap background work for unusually long chapters. No full-library scan.
    const count = Math.min(texts.length, 256);
    await Promise.all(Array.from({ length: Math.min(count, 4) }, async () => {
      while (cursor < count && !signal.aborted) {
        const index = cursor++;
        const key = await speechKey(options.provider, options.cacheVersion, voice, texts[index]!);
        try {
          const response = await fetchSpeechMetadata(`${options.cdnBase.replace(/\/$/u, "")}/${speechObjectBase(options.provider, key, options.scope)}.json`, signal);
          if (!response.ok) continue;
          const source = validateSpeechSource(response.record, options.cdnBase, key, options.scope);
          if (source) known[index] = source.duration;
        } catch { if (signal.aborted) return; }
      }
    }));
    return known;
  }

  async function speechKey(provider: string, version: string, voice: string, text: string): Promise<string> {
    const data = JSON.stringify([provider, version, voice, text.replace(/\s+/gu, " ").trim()]);
    return config.digest(data);
  }

  return { loadSpeechProviders, requestSpeech, loadCachedSpeechDurations, speechKey };
}

export function speechObjectBase(provider: string, key: string, scope: SpeechScope = "book"): string {
  return `audio/speech/v1/${scope === "news" ? "news/" : ""}segments/${provider}/${key.slice(0, 2)}/${key}`;
}

export function validateSpeechSource(value: unknown, cdn: string, key?: string, scope: SpeechScope = "book"): SpeechSource | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.formatVersion !== "jojo-speech-segment/1" || typeof record.key !== "string" || (key && record.key !== key)
      || typeof record.object !== "string" || !/^audio\/speech\/v1\/(news\/)?segments\/(edge|mimo)\/[a-f0-9]{2}\/[a-f0-9]{64}\/[a-f0-9]{64}\.mp3$/u.test(record.object)
      || !record.object.includes(`/${record.sourceKey ?? record.key}/`) || typeof record.duration !== "number"
      || !Number.isFinite(record.duration) || record.duration <= 0 || record.duration > 600) return null;
  if (record.sourceKey !== undefined && (typeof record.sourceKey !== "string" || !/^[a-f0-9]{64}$/u.test(record.sourceKey)
      || !["mimo", "edge"].includes(String(record.provider))
      || !record.object.startsWith(`audio/speech/v1/${scope === "news" ? "news/" : ""}segments/${record.provider}/`))) return null;
  if (record.object.startsWith("audio/speech/v1/news/") !== (scope === "news")) return null;
  if (scope === "news" && (typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt) || record.expiresAt * 1000 <= Date.now())) return null;
  const base = new URL(cdn.endsWith("/") ? cdn : `${cdn}/`);
  if (base.protocol !== "https:") return null;
  return { url: new URL(record.object, base).href, duration: record.duration };
}
