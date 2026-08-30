import { load } from "cheerio";
import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";

const CREDIT_LINE = /^(?:(?:文案|记者|海报制作|海报设计|摄影|编辑|制作|漫画)\s*[:：]|新华社.*出品)/u;
const PHOTO_CREDIT = /(?:新华社(?:记者|发)?[^。；]{0,60}(?:摄|图)|(?:记者|摄影)[^。；]{0,40}摄)/u;
const RESIDUAL_PAGE = /(?:页面|内容|文章|稿件).{0,8}(?:不存在|已删除|已下线)|(?:访问失败|加载失败|系统错误|服务异常|请稍后重试|请登录后(?:查看|阅读)|暂无内容)/u;

function normalizedText(value: string): string {
  return value.replaceAll(/pagebreak/giu, " ").replaceAll(/\s+/gu, " ").trim();
}

export function isXinhuaResidualPage(value: string, blocks: number): boolean {
  const normalized = normalizedText(value);
  return normalized.length <= 180 && blocks <= 3
    && (RESIDUAL_PAGE.test(normalized) || /^(?:404|403)(?:\s|$)/u.test(normalized));
}

function escapedParagraph(value: string): string {
  const escaped = value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<p>${escaped}</p>`;
}

function captionParagraphs(document: ReturnType<typeof load>, container: ReturnType<ReturnType<typeof load>>): Set<unknown> {
  const captions = new Set<unknown>();
  container.find("img").each((_index, element) => {
    const wrapper = document(element).closest("p,figure,div").first();
    if (!wrapper.length) return;
    const segment: Array<ReturnType<typeof document>> = [];
    for (let node = wrapper.next(); node.length && !node.find("img").length; node = node.next()) {
      if (!node.is("p")) break;
      if (normalizedText(node.text())) segment.push(node);
    }
    const credit = segment.find((node) => PHOTO_CREDIT.test(normalizedText(node.text())));
    if (!credit) return;
    const first = segment[0];
    if (first) captions.add(first.get(0));
    captions.add(credit.get(0));
  });
  return captions;
}

/**
 * Xinhua's authoritative article container is narrower than `#detail`: the
 * latter also owns the correction/editor controls. Treating this publisher
 * container as authoritative keeps legitimate short photo dispatches from
 * falling through to the page-wide generic extractor.
 */
export function extractXinhuaBody(html: string, quality: BodyQuality, pageUrl?: string): string | undefined {
  const document = load(html);
  const container = document("#detailContent").first();
  if (!container.length) return undefined;
  if (isXinhuaResidualPage(container.text(), container.find("p,h2,h3,h4,blockquote").length)) return undefined;
  const captions = captionParagraphs(document, container);
  const blocks = container.find("p,h2,h3,h4,blockquote").toArray().flatMap((element) => {
    const node = document(element);
    if (node.find("img").length || captions.has(element)) return [];
    const text = normalizedText(node.text());
    if (!text || CREDIT_LINE.test(text)) return [];
    if (node.is("p") && text.length < 48 && node.find("strong,b").length) {
      return [`<h3>${node.html() ?? text}</h3>`];
    }
    return [document.html(element)];
  });
  if (!blocks.length && container.find("img").length) {
    const credits = container.find("p").toArray()
      .map((element) => normalizedText(document(element).text()))
      .filter((value) => CREDIT_LINE.test(value));
    if (credits.length) return credits.map(escapedParagraph).join("");
  }
  return semanticHtmlBlocks(blocks, {
    minimumCharacters: Math.min(quality.minimumCharacters ?? 80, 20),
    minimumParagraphs: 1,
  }, pageUrl);
}

// Kept for downstream imports made before the full Xinhua adapter existed.
export const extractXinhuaImageStoryBody = extractXinhuaBody;
