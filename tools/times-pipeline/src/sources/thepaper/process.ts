import { load } from "cheerio";
import { semanticParagraphs, type BodyQuality } from "../../content/paragraphs.js";

type JsonObject = Record<string, unknown>;

const IMAGE_ONLY_BODY = '<figure data-publisher-image-only="true"></figure>';

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function semanticPublisherBody(value: string, quality: BodyQuality): string | undefined {
  const fragment = load(value, undefined, false);
  const blocks = fragment("p, h2, h3, blockquote").toArray();
  const paragraphs = blocks.length
    ? blocks.map((element) => fragment(element).text())
    : [fragment.root().text()];
  return semanticParagraphs(paragraphs, quality)
    ?? (fragment("img[src], img[data-src]").length ? IMAGE_ONLY_BODY : undefined);
}

function embeddedBody(html: string): string | undefined {
  const document = load(html);
  const value = document("script#__NEXT_DATA__").text();
  if (!value) return undefined;
  try {
    const root = object(JSON.parse(value));
    const pageProps = object(object(root?.props)?.pageProps);
    const detailData = object(pageProps?.detailData);
    const specialDetail = object(detailData?.specialDetail);
    const detail = object(detailData?.contentDetail)
      ?? object(detailData?.liveDetail)
      ?? object(specialDetail?.specialInfo);
    return typeof detail?.content === "string" ? detail.content : undefined;
  } catch {
    return undefined;
  }
}

export function extractThepaperBody(html: string, quality: BodyQuality): string | undefined {
  const value = embeddedBody(html);
  if (value) return semanticPublisherBody(value, quality);

  // Discovery persists the publisher-owned content fragment rather than a full page.
  if (!/<(?:html|body)\b/iu.test(html)) return semanticPublisherBody(html, quality);
  return undefined;
}
