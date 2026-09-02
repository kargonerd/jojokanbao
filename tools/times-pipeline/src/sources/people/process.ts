import { load } from "cheerio";
import type { ArticleBodyExtraction } from "../../content/body.js";
import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";

const PHOTO_CAPTION = /(?:人民网(?:记者)?[^。]{0,50}摄|(?:记者|摄影)[^。]{0,40}摄)(?:[）)]|$)/u;
const RESIDUAL_PAGE = /(?:页面|内容|文章|稿件).{0,8}(?:不存在|已删除|已下线)|(?:访问失败|加载失败|系统错误|服务异常|请稍后重试|请登录后(?:查看|阅读)|暂无内容)/u;
const PLAYER_SELECTOR = "video,.video-js,[class*='vjs-'],[id^='q_v_'],[id^='video_q_v_']";
const EMBEDDED_MEDIA_SELECTOR = `${PLAYER_SELECTOR},audio,iframe,object,embed`;
const NON_ARTICLE_SELECTOR = `script,style,noscript,.paper_num,[class*='share'],[class*='recommend'],${EMBEDDED_MEDIA_SELECTOR}`;

function text(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

export function isPeopleResidualPage(value: string, blocks: number): boolean {
  const normalized = text(value);
  return normalized.length <= 180 && blocks <= 3
    && (RESIDUAL_PAGE.test(normalized) || /^(?:404|403)(?:\s|$)/u.test(normalized));
}

function articleContainer(document: ReturnType<typeof load>): ReturnType<ReturnType<typeof load>> {
  return ["#rm_txt_zw", "#rwb_zw", ".rm_txt_con"]
    .map((selector) => document(selector).first())
    .find((candidate) => candidate.length > 0) ?? document("").first();
}

export function isPeopleVideoPage(html: string): boolean {
  const document = load(html);
  const container = articleContainer(document);
  return container.length > 0 && container.find(PLAYER_SELECTOR).length > 0;
}

function captionElements(document: ReturnType<typeof load>, container: ReturnType<ReturnType<typeof load>>): Set<unknown> {
  const captions = new Set<unknown>();
  container.find("img").each((_index, element) => {
    const image = document(element);
    if (image.closest(`.paper_num,[class*='share'],[class*='recommend'],${EMBEDDED_MEDIA_SELECTOR}`).length) return;
    const wrapper = image.closest("p,figure,div").first();
    const next = wrapper.nextAll("p").first();
    if (!next.length) return;
    const caption = text(next.text());
    const alt = text(image.attr("alt") ?? "");
    if (caption && ((alt && caption === alt) || PHOTO_CAPTION.test(caption))) captions.add(next.get(0));
  });
  return captions;
}

export function extractPeopleBody(
  html: string,
  quality: BodyQuality,
  pageUrl?: string,
): string | ArticleBodyExtraction | undefined {
  const document = load(html);
  const container = articleContainer(document);
  if (!container.length) return undefined;
  const hasPlayer = container.find(PLAYER_SELECTOR).length > 0;
  const semanticContainer = container.clone();
  semanticContainer.find(NON_ARTICLE_SELECTOR).remove();
  if (isPeopleResidualPage(semanticContainer.text(), semanticContainer.find("p,h2,h3,h4,blockquote,ul,ol").length)) {
    return undefined;
  }
  const captions = captionElements(document, container);
  const blocks = container.find("p,h2,h3,h4,blockquote,ul,ol").toArray().flatMap((element) => {
    const node = document(element);
    if (node.closest(`.paper_num,[class*='share'],[class*='recommend'],${EMBEDDED_MEDIA_SELECTOR}`).length) return [];
    if (node.find(`img,${EMBEDDED_MEDIA_SELECTOR}`).length || captions.has(element)) return [];
    const value = text(node.text());
    if (!value || /^分享让更多人看到$/u.test(value)) return [];
    if (node.is("p") && value.length < 48 && node.find("strong,b").length) {
      return [`<h3>${node.html() ?? value}</h3>`];
    }
    return [document.html(element)];
  });
  const body = semanticHtmlBlocks(blocks, {
    minimumCharacters: Math.min(quality.minimumCharacters ?? 40, 20),
    minimumParagraphs: 1,
  }, pageUrl);
  if (body) return body;
  if (!hasPlayer) return undefined;

  // Browser capture serializes Video.js' generated accessibility controls
  // inside People.com's publisher-owned body container. An authoritative
  // empty result prevents the shared selector fallback from promoting those
  // hidden menus and modal descriptions to article text.
  return {
    html: "",
    completeness: "publisher-complete",
    evidence: {
      kind: "unsupported-media",
      marker: "video-player",
      location: "#rm_txt_zw, #rwb_zw, .rm_txt_con",
    },
  };
}
