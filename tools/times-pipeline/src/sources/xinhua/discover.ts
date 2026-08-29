import { load, type CheerioAPI } from "cheerio";
import { discoverHtmlListing, sectionUrl } from "../../discovery/html-listing.js";
import { isFullDiscoveryBody, plainText } from "../../text.js";
import type { RouteDiscoveryEndpoint, SourceConfig } from "../../types.js";

type Endpoint = RouteDiscoveryEndpoint;

const productionCredit = /^(?:记者|编导|摄像|摄影|剪辑|编辑|制作|监制|策划|统筹|配音|新华社音视频部制作|新华社出品)\s*[:：]?/u;

function escapedParagraph(value: string): string {
  const escaped = value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<p>${escaped}</p>`;
}

export function isXinhuaVideoOnlyPage(html: string, source: SourceConfig): boolean {
  const document = load(html);
  const container = document("#detailContent").first();
  if (!container.length || !container.find(".pageVideo[video_src], video, [video_src]").length) return false;

  const textContainer = container.clone();
  textContainer.find(".pageVideo, video, iframe, script, style, noscript").remove();
  const paragraphs = textContainer.find("p").toArray()
    .map((element) => plainText(document(element).text()))
    .filter((value) => value && !productionCredit.test(value));
  const fallbackText = plainText(textContainer.text());
  const substantive = paragraphs.length ? paragraphs : fallbackText && !productionCredit.test(fallbackText) ? [fallbackText] : [];
  const body = substantive.map(escapedParagraph).join("");
  return !isFullDiscoveryBody(
    body,
    source.content.minimumFullCharacters,
    source.content.minimumFullParagraphs,
  );
}

const articlePrefixes: Record<string, string[]> = {
  politics: ["/politics/"],
  world: ["/world/"],
  fortune: ["/fortune/"],
  comments: ["/comments/"],
  "hong-kong-macao": ["/gangao/"],
  taiwan: ["/tw/"],
  military: ["/mil/", "/milpro/"],
  law: ["/law/"],
  finance: ["/money/"],
};

export function xinhuaPublicationDate(document: CheerioAPI): string | undefined {
  const header = document(".header-time").first();
  if (!header.length) return undefined;
  const year = plainText(header.find(".year").text()).match(/\d{4}/u)?.[0];
  const monthAndDay = plainText(header.find(".day").text()).match(/\d{1,2}/gu);
  const time = plainText(header.find(".time").text()).match(/\d{1,2}:\d{2}(?::\d{2})?/u)?.[0];
  if (!year || !monthAndDay || monthAndDay.length < 2 || !time) return undefined;
  const month = monthAndDay[0]!.padStart(2, "0");
  const day = monthAndDay[1]!.padStart(2, "0");
  return `${year}-${month}-${day} ${time}`;
}

export function discoverXinhua(source: SourceConfig, endpoint: Endpoint, fetchedAt: string) {
  const prefixes = articlePrefixes[endpoint.route];
  if (!prefixes) throw new Error(`${source.id}: unsupported route: ${endpoint.route}`);
  return discoverHtmlListing(source, fetchedAt, {
    listingUrl: sectionUrl(source, endpoint.route),
    articlePathPrefixes: prefixes,
    maximumItems: endpoint.maximumItems,
    bodySelectors: ["#detailContent"],
    publicationDateSelectors: ["#pubtime_baidu", ".header-time", ".mheader .info"],
    publicationDateExtractor: xinhuaPublicationDate,
    publicationDateMode: "wall-clock",
    isUnsupportedMedia: (html) => isXinhuaVideoOnlyPage(html, source),
    version: "xinhua-html/2",
  });
}
