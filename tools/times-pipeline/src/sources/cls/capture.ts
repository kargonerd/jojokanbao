import { BROWSER_USER_AGENT } from "../../network/headers.js";
import type { CapturedHtmlPage } from "../../capture/http.js";

function isHtmlDocument(value: string): boolean {
  return /^\s*(?:<!doctype\s+html\b|<html\b)/iu.test(value);
}

/**
 * CLS currently serves complete SSR article HTML without a Content-Type
 * header. The shared direct fetcher intentionally rejects untyped bodies, so
 * this publisher adapter verifies the document signature before accepting it.
 */
export async function captureClsPage(url: string, timeoutSeconds: number): Promise<CapturedHtmlPage | undefined> {
  const capturedAt = new Date().toISOString();
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
        "user-agent": BROWSER_USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutSeconds * 1_000),
    });
    const html = await response.text();
    if (!isHtmlDocument(html)) return undefined;
    return {
      method: "direct",
      requestedUrl: url,
      finalUrl: response.url || url,
      status: response.status,
      originalHtml: html,
      renderedHtml: html,
      capturedAt,
    };
  } catch {
    return undefined;
  }
}
