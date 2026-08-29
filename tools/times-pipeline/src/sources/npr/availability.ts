import type { PageAvailabilityInput, UnavailablePageReason } from "../../types.js";

export function classifyNprUnavailablePage(input: PageAvailabilityInput): UnavailablePageReason | undefined {
  const html = input.html ?? "";
  if (/\bno-transcript\b/iu.test(html)
    || /<div\b[^>]*\bclass=["'][^"']*\btranscript\b[^"']*\bstorytext\b[^"']*["'][^>]*>/iu.test(html)
    || /\baria-label=["']Transcript["']/iu.test(html)) {
    return "UnsupportedMedia";
  }
  if (input.hasFullBody) return undefined;
  return undefined;
}
