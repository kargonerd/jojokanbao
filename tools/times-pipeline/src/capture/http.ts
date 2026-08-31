import { BROWSER_USER_AGENT } from "../network/headers.js";

export interface CapturedHtmlPage {
  method: "direct" | "browser";
  requestedUrl: string;
  finalUrl: string;
  status?: number;
  originalHtml?: string;
  renderedHtml?: string;
  capturedAt: string;
  error?: string;
  /** A publisher adapter proved that browser fallback cannot represent the requested article. */
  browserFallback?: "forbidden";
}

export async function fetchDirectPage(url: string, timeoutSeconds: number): Promise<CapturedHtmlPage> {
  const capturedAt = new Date().toISOString();
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
        "user-agent": BROWSER_USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutSeconds * 1_000),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const html = /(?:text\/html|application\/xhtml\+xml)/iu.test(contentType) ? await response.text() : undefined;
    return {
      method: "direct",
      requestedUrl: url,
      finalUrl: response.url || url,
      status: response.status,
      ...(html ? { originalHtml: html, renderedHtml: html } : {}),
      capturedAt,
      ...(!html ? { error: `NonHtmlResponse:${contentType || "unknown"}` } : {}),
    };
  } catch (error) {
    return {
      method: "direct",
      requestedUrl: url,
      finalUrl: url,
      capturedAt,
      error: error instanceof Error ? error.name : "DirectFetchError",
    };
  }
}

export async function downloadDirectAsset(url: string, referer: string, timeoutSeconds: number): Promise<{ body: Buffer; mediaType: string } | undefined> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8", referer, "user-agent": BROWSER_USER_AGENT },
      signal: AbortSignal.timeout(timeoutSeconds * 1_000),
    });
    if (!response.ok) return undefined;
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > 30_000_000) return undefined;
    const body = Buffer.from(await response.arrayBuffer());
    if (!body.length || body.length > 30_000_000) return undefined;
    return { body, mediaType: (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase() };
  } catch {
    return undefined;
  }
}
