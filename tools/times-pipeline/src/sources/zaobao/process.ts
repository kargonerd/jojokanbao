import { load } from "cheerio";
import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";

export function extractZaobaoBody(html: string, quality: BodyQuality, pageUrl?: string): string | undefined {
  const document = load(html);
  const body = document("article .articleBody").first().clone();
  if (!body.length) return undefined;
  body.find([
    ".bff-recommend-article",
    ".inline-figure",
    "[class*='advert']",
    "aside",
    "button",
    "form",
    "noscript",
    "script",
    "style",
  ].join(",")).remove();
  body.find("h2,h3,h4").filter((_index, element) =>
    /^(?:延伸阅读|推荐阅读|相关阅读)$/u.test(document(element).text().replaceAll(/\s+/gu, " ").trim())).remove();
  const blocks = body.find("p,h2,h3,h4,blockquote,ul,ol,pre")
    .toArray()
    .map((element) => document.html(element));
  return semanticHtmlBlocks(blocks, quality, pageUrl);
}
