import { load } from "cheerio";
import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";

type JsonObject = Record<string, unknown>;

const IMAGE_ONLY_BODY = '<figure data-publisher-image-only="true"></figure>';
const PROMOTIONAL_TEXT = /^(?:扫码下载.*澎湃新闻客户端|下载澎湃新闻客户端|澎湃新闻客户端)$/u;
const RESIDUAL_PAGE = /(?:页面|内容|文章|稿件).{0,8}(?:不存在|已删除|已下线)|(?:访问失败|加载失败|系统错误|服务异常|请稍后重试|请登录后(?:查看|阅读)|暂无内容)/u;
const PUBLISHER_BODY_SELECTORS = ["[class*='cententWrap__']", ".index_cententWrap", ".news_txt", "article"] as const;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function residualPage(value: string): boolean {
  const fragment = load(value, undefined, false);
  const text = fragment.root().text().replaceAll(/\s+/gu, " ").trim();
  const blocks = fragment("p,h2,h3,h4,blockquote,ul,ol").length;
  return text.length <= 180 && blocks <= 3 && (RESIDUAL_PAGE.test(text) || /^(?:404|403)(?:\s|$)/u.test(text));
}

function truncatePublisherPromotion(value: string): string | undefined {
  const fragment = load(value, undefined, false);
  const promotional = fragment("p,h2,h3,h4,ul,ol").filter((_index, element) =>
    PROMOTIONAL_TEXT.test(fragment(element).text().replaceAll(/\s+/gu, " ").trim())).first();
  if (promotional.length) {
    promotional.nextAll().remove();
    promotional.remove();
  }
  const bounded = fragment.html().trim();
  return bounded && !residualPage(bounded) ? bounded : undefined;
}

function publisherDomBody(html: string): string | undefined {
  const document = load(html);
  for (const selector of PUBLISHER_BODY_SELECTORS) {
    const container = document(selector).first();
    const value = container.html()?.trim();
    if (value) return value;
  }
  return undefined;
}

function semanticPublisherBody(
  value: string,
  quality: BodyQuality,
  pageUrl: string | undefined,
  authoritativePayload: boolean,
): string | undefined {
  const fragment = load(value, undefined, false);
  fragment([
    ".image_desc",
    ".video_desc",
    "[class*='recommend']",
    "[class*='advert']",
    "script",
    "style",
    "noscript",
  ].join(",")).remove();
  const blocks = fragment("p, h2, h3, h4, blockquote").toArray();
  const paragraphs = blocks.length
    ? blocks.map((element) => {
      const node = fragment(element);
      const text = node.text().replaceAll(/\s+/gu, " ").trim();
      return node.is("p") && text.length < 48 && node.find("strong,b").length
        ? `<h3>${node.html() ?? text}</h3>`
        : fragment.html(element);
    })
    : [`<p>${fragment.html()}</p>`];
  const thresholds: BodyQuality = authoritativePayload
    ? { minimumCharacters: Math.min(quality.minimumCharacters ?? 100, 20), minimumParagraphs: 1 }
    : quality;
  return semanticHtmlBlocks(paragraphs, thresholds, pageUrl)
    ?? (authoritativePayload && fragment("img[src], img[data-src]").length ? IMAGE_ONLY_BODY : undefined);
}

export function embeddedThepaperBody(html: string): string | undefined {
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

/**
 * Returns the publisher-owned fragment with the client-download footer and
 * everything after that footer removed. Body and image extraction deliberately
 * share this boundary so an asset cannot survive after prose has terminated.
 */
export function boundedThepaperBody(html: string): string | undefined {
  const embedded = embeddedThepaperBody(html);
  const value = embedded
    ?? publisherDomBody(html)
    ?? (!/<(?:html|body)\b/iu.test(html) ? html : undefined);
  return value ? truncatePublisherPromotion(value) : undefined;
}

export function extractThepaperBody(html: string, quality: BodyQuality, pageUrl?: string): string | undefined {
  const embedded = embeddedThepaperBody(html);
  const value = boundedThepaperBody(html);
  if (!value) return undefined;

  // Only the typed Next.js article payload may opt into the source-specific
  // short-dispatch threshold. Persisted discovery fragments still have to meet
  // the configured source quality threshold.
  return semanticPublisherBody(value, quality, pageUrl, embedded !== undefined);
}
