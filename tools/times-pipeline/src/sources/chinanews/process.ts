import { load } from "cheerio";
import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";

const ARTICLE_SELECTORS = [".left_zw", ".content_desc"] as const;
const IMAGE_ONLY_BODY = '<figure data-publisher-image-only="true"></figure>';
const IMAGE_ONLY_POSTER_TITLE = /^(?:直播海报|海报)[：:]/u;
const EXCLUDED_SELECTOR = [
  "script",
  "style",
  "noscript",
  "iframe",
  "form",
  ".adInContent",
  ".adEditor",
  "#function_code_page",
  ".pictext",
  "[class*='caption']",
  "figcaption",
].join(",");
const RESIDUAL_PAGE = /(?:页面|内容|文章|稿件).{0,8}(?:不存在|已删除|已下线)|(?:访问失败|加载失败|系统错误|服务异常|请稍后重试|请登录后(?:查看|阅读)|暂无内容)/u;

function text(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function publisherImageUrl(value: string | undefined, pageUrl: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, pageUrl);
    return ["http:", "https:"].includes(url.protocol)
      && (url.hostname === "chinanews.com.cn" || url.hostname.endsWith(".chinanews.com.cn"))
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

export interface ChinanewsImageOnlyPosterInspection {
  imageOnlyShell: boolean;
  sourceUrl?: string;
}

function inspectPublisherImageOnlyPoster(
  document: ReturnType<typeof load>,
  article: ReturnType<ReturnType<typeof load>>,
  pageUrl: string | undefined,
): ChinanewsImageOnlyPosterInspection {
  const heading = text(document("h1").first().text());
  if (!IMAGE_ONLY_POSTER_TITLE.test(heading)) return { imageOnlyShell: false };

  const content = article.clone();
  content.find(EXCLUDED_SELECTOR).remove();
  const prose = content.clone();
  prose.find("img,picture,source").remove();
  if (text(prose.text())) return { imageOnlyShell: false };

  const sourceUrls = new Set<string>();
  content.find("img[src],img[data-src],img[data-original]").each((_index, element) => {
    const image = document(element);
    const value = image.attr("data-src") ?? image.attr("data-original") ?? image.attr("src");
    if (!value || value.startsWith("data:") || value.startsWith("blob:")) return;
    try {
      sourceUrls.add(new URL(value, pageUrl).toString());
    } catch {}
  });
  if (sourceUrls.size !== 1) return { imageOnlyShell: true };
  const [sourceUrl] = sourceUrls;
  const acceptedUrl = publisherImageUrl(sourceUrl, pageUrl);
  return acceptedUrl
    ? { imageOnlyShell: true, sourceUrl: acceptedUrl }
    : { imageOnlyShell: true };
}

export function inspectChinanewsImageOnlyPoster(
  html: string,
  pageUrl: string,
): ChinanewsImageOnlyPosterInspection {
  const document = load(html);
  const article = ARTICLE_SELECTORS
    .map((selector) => document(selector).first())
    .find((candidate) => candidate.length > 0);
  return article
    ? inspectPublisherImageOnlyPoster(document, article, pageUrl)
    : { imageOnlyShell: false };
}

export function isChinanewsSectionHeading(value: string): boolean {
  return value.length >= 4 && value.length <= 28
    && !/[。！？；：:）)]$/u.test(value)
    && !/(?:记者|编辑|来源|日电|摄影|摄\b|完$)/u.test(value);
}

export function isChinanewsSemanticBlock(tagName: string, value: string): boolean {
  if (!value) return false;
  if (["h2", "h3", "h4"].includes(tagName)) return true;
  if (tagName === "p" && isChinanewsSectionHeading(value)) return true;
  return value.length >= 20;
}

export function isChinanewsResidualPage(value: string, blocks: number): boolean {
  const normalized = text(value);
  return normalized.length <= 180 && blocks <= 3
    && (RESIDUAL_PAGE.test(normalized) || /^(?:404|403)(?:\s|$)/u.test(normalized));
}

export function extractChinanewsBody(html: string, quality: BodyQuality, pageUrl?: string): string | undefined {
  const document = load(html);
  const article = ARTICLE_SELECTORS
    .map((selector) => document(selector).first())
    .find((candidate) => candidate.length > 0);
  if (!article) return undefined;

  const body = article.clone();
  body.find(EXCLUDED_SELECTOR).remove();

  const blocks = body.find("p, h2, h3, h4, blockquote").toArray();
  if (isChinanewsResidualPage(body.text(), blocks.length)) return undefined;
  const paragraphs = blocks.length
    ? blocks.flatMap((element) => {
      const node = document(element);
      const value = text(node.text());
      const tagName = node.prop("tagName")?.toLowerCase() ?? "";
      if (!isChinanewsSemanticBlock(tagName, value)) return [];
      return [node.is("p") && isChinanewsSectionHeading(value)
        ? `<h3>${node.html() ?? value}</h3>`
        : document.html(element)];
    })
    : [`<p>${body.html() ?? body.text()}</p>`];
  const semanticBody = semanticHtmlBlocks(paragraphs, {
    minimumCharacters: Math.min(quality.minimumCharacters ?? 100, 20),
    minimumParagraphs: 1,
  }, pageUrl);
  const poster = semanticBody ? undefined : inspectPublisherImageOnlyPoster(document, article, pageUrl);
  return semanticBody ?? (poster?.sourceUrl ? IMAGE_ONLY_BODY : undefined);
}
