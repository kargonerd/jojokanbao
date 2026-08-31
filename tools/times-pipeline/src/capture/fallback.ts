import type { CapturedHtmlPage } from "./http.js";

export interface PageCaptureFallbackInput {
  direct?: () => Promise<CapturedHtmlPage | undefined>;
  browser: () => Promise<CapturedHtmlPage>;
  hasBody: (page: CapturedHtmlPage) => boolean;
}

/**
 * Preserve publisher terminal decisions across the shared direct/browser
 * orchestration. A forbidden fallback applies only to this capture attempt;
 * the scheduler may try the publisher adapter again in a future run.
 */
export async function captureWithBrowserFallback(
  input: PageCaptureFallbackInput,
): Promise<CapturedHtmlPage> {
  const page = await input.direct?.();
  if (page?.browserFallback === "forbidden") return page;
  return page && input.hasBody(page) ? page : input.browser();
}

export function allowsInRunCaptureRetry(page: CapturedHtmlPage | undefined): boolean {
  return page?.browserFallback !== "forbidden";
}
