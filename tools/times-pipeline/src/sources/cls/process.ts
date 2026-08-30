import { load } from "cheerio";
import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";
import type { Candidate } from "../../types.js";

type JsonObject = Record<string, unknown>;
const RESIDUAL_PAGE = /(?:页面|内容|文章|稿件).{0,8}(?:不存在|已删除|已下线)|(?:访问失败|加载失败|系统错误|服务异常|请稍后重试|请登录后(?:查看|阅读)|暂无内容)/u;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function validPublisherContent(value: string): boolean {
  const fragment = load(value, undefined, false);
  const text = fragment.root().text().replaceAll(/\s+/gu, " ").trim();
  const blocks = fragment("p,h2,h3,h4,blockquote,ul,ol").length;
  return Boolean(text || fragment("img[src],img[data-src]").length)
    && !(text.length <= 180 && blocks <= 3
      && (RESIDUAL_PAGE.test(text) || /^(?:404|403)(?:\s|$)/u.test(text)));
}

export function embeddedClsBody(html: string): string | undefined {
  const document = load(html);
  const value = document("script#__NEXT_DATA__").text();
  if (!value) return undefined;
  try {
    const root = object(JSON.parse(value));
    const pageProps = object(object(root?.props)?.pageProps);
    const article = object(pageProps?.articleDetail);
    return typeof article?.content === "string" && validPublisherContent(article.content)
      ? article.content
      : undefined;
  } catch {
    return undefined;
  }
}

export function extractClsBody(html: string, quality: BodyQuality, pageUrl?: string): string | undefined {
  const content = embeddedClsBody(html);
  if (!content) return undefined;
  const fragment = load(content, undefined, false);
  fragment(".image_desc,[class*='caption'],script,style,noscript").remove();
  const blocks = fragment("p, h2, h3, h4, blockquote").toArray();
  return semanticHtmlBlocks(
    blocks.length ? blocks.map((element) => {
      const node = fragment(element);
      const text = node.text().replaceAll(/\s+/gu, " ").trim();
      return node.is("p") && text.length < 48 && node.find("strong,b").length
        ? `<h3>${node.html() ?? text}</h3>`
        : fragment.html(element);
    }) : [`<p>${fragment.html()}</p>`],
    {
      minimumCharacters: Math.min(quality.minimumCharacters ?? 100, 20),
      minimumParagraphs: 1,
    },
    pageUrl,
  );
}

export function processCls(candidate: Candidate): Candidate {
  return { ...candidate, publisherCategories: [...new Set(candidate.publisherCategories)] };
}
