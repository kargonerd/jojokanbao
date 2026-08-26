export type UnavailablePageReason = "UnsupportedMedia" | "HardPaywall";

export function unavailablePageReason(input: {
  sourceId: string;
  title: string;
  url: string;
  html?: string;
  hasFullBody: boolean;
}): UnavailablePageReason | undefined {
  if (input.hasFullBody) return undefined;
  const html = input.html ?? "";
  let pathname = "";
  try {
    pathname = new URL(input.url).pathname;
  } catch {
    // Classification can continue from the captured markup.
  }
  if (/\/(?:video|videos|gallery|galleries|picture|pictures)(?:\/|$)/iu.test(pathname)) return "UnsupportedMedia";
  if (input.sourceId === "npr" && /\bno-transcript\b/iu.test(html)) return "UnsupportedMedia";
  if (input.sourceId === "cls" && (
    /<video\b|点击按住可拖动视频/iu.test(html)
    || /(?:一图看懂|航拍画面)/u.test(input.title)
  )) return "UnsupportedMedia";
  if (input.sourceId === "xinhua" && /新华社音视频部制作/u.test(html)) return "UnsupportedMedia";
  if (input.sourceId === "scmp" && /SCMP Plus subscription is required for access/iu.test(html)) return "HardPaywall";
  return undefined;
}
