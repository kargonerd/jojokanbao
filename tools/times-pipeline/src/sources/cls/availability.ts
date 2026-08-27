import type { PageAvailabilityInput, UnavailablePageReason } from "../../types.js";

export function classifyClsUnavailablePage(input: PageAvailabilityInput): UnavailablePageReason | undefined {
  if (input.hasFullBody) return undefined;
  return /<video\b|点击按住可拖动视频/iu.test(input.html ?? "")
    || /(?:一图看懂|航拍画面)/u.test(input.title)
    ? "UnsupportedMedia"
    : undefined;
}
