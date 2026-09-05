export const SPEECH_VOICES = [
  { id: "zh-CN-XiaoxiaoNeural", label: "女声 · 晓晓" },
  { id: "zh-CN-YunxiNeural", label: "男声 · 云希" },
  { id: "zh-CN-YunyangNeural", label: "新闻 · 云扬" },
] as const;

export type SpeechVoice = string;

export interface SpeechProvider {
  id: string;
  label: string;
  description: string;
  available: boolean;
  cacheVersion?: string;
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
  id: "edge", label: "Microsoft Edge", description: "在线朗读 · 非正式接口", available: true,
  voices: SPEECH_VOICES.map((voice) => ({ id: voice.id, label: voice.label.split(" · ")[1]!, description: voice.label.split(" · ")[0]! })),
}];

export interface SpeechSource { url: string; duration: number }
export interface SpeechClientConfig {
  allowed: () => boolean;
  apiUrl: (path: "/api/v1/speech" | "/api/v1/speech/providers") => string;
  digest: (text: string) => Promise<string>;
}

export function createSpeechClient(config: SpeechClientConfig) {
  async function loadSpeechProviders(signal?: AbortSignal): Promise<SpeechCapabilities> {
    if (!config.allowed()) throw new Error("请先登录并开通听读功能");
    const response = await fetch(config.apiUrl("/api/v1/speech/providers"), { signal });
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
    options: { provider: string; cacheVersion?: string; cdnBase?: string | null } = { provider: "edge" },
  ): Promise<Blob | SpeechSource> {
    // The product intentionally uses a soft client-side gate, not media authorization.
    if (!config.allowed()) throw new Error("请先登录并开通听读功能");
    if (options.cdnBase && options.cacheVersion) {
      const key = await speechKey(options.provider, options.cacheVersion, voice, text);
      const base = `${options.cdnBase.replace(/\/$/u, "")}/${speechObjectBase(options.provider, key)}`;
      const cached = await fetchSpeechMetadata(`${base}.json`, signal).catch((error: unknown) => {
        if (signal?.aborted) throw error;
        return null;
      });
      if (cached?.ok) {
        const record: unknown = await cached.json().catch(() => null);
        const source = validateSpeechSource(record, options.cdnBase, key);
        if (source) return source;
      }
      // The backend checks the authoritative B2 object again; CDN misses/errors do
      // not themselves authorize duplicate synthesis.
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const response = await fetch(config.apiUrl("/api/v1/speech"), {
      method: "POST",
      signal,
      headers,
      body: JSON.stringify({ text, voice, provider: options.provider }),
    });
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      throw new Error(responseError(payload, response.status));
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.startsWith("application/json") && options.cdnBase) {
      const key = options.cacheVersion ? await speechKey(options.provider, options.cacheVersion, voice, text) : undefined;
      const source = validateSpeechSource(await response.json(), options.cdnBase, key);
      if (!source) throw new Error("语音服务返回了无效音频地址");
      return source;
    }
    if (!contentType.startsWith("audio/")) throw new Error("语音服务返回了无效内容");
    return response.blob();
  }



  async function fetchSpeechMetadata(url: string, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 6000);
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  /** Read-only metadata warming: never synthesizes missing parts. */
  async function loadCachedSpeechDurations(
    texts: string[], voice: string, signal: AbortSignal,
    options: { provider: string; cacheVersion: string; cdnBase: string },
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
          const response = await fetchSpeechMetadata(`${options.cdnBase.replace(/\/$/u, "")}/${speechObjectBase(options.provider, key)}.json`, signal);
          if (!response.ok) continue;
          const source = validateSpeechSource(await response.json(), options.cdnBase, key);
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

export function speechObjectBase(provider: string, key: string): string {
  return `audio/speech/v1/segments/${provider}/${key.slice(0, 2)}/${key}`;
}

export function validateSpeechSource(value: unknown, cdn: string, key?: string): SpeechSource | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.formatVersion !== "jojo-speech-segment/1" || typeof record.key !== "string" || (key && record.key !== key)
      || typeof record.object !== "string" || !/^audio\/speech\/v1\/segments\/(edge|mimo)\/[a-f0-9]{2}\/[a-f0-9]{64}\/[a-f0-9]{64}\.mp3$/u.test(record.object)
      || !record.object.includes(`/${record.key}/`) || typeof record.duration !== "number"
      || !Number.isFinite(record.duration) || record.duration <= 0 || record.duration > 600) return null;
  const base = new URL(cdn.endsWith("/") ? cdn : `${cdn}/`);
  if (base.protocol !== "https:") return null;
  return { url: new URL(record.object, base).href, duration: record.duration };
}
