import { load, type CheerioAPI } from "cheerio";
import type { ArticleBodyExtraction } from "../../content/body.js";
import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";

export type FtDocumentElement = ReturnType<CheerioAPI>[number];

const BLOCK_SELECTOR = "p, h2, h3, h4, blockquote, ul, ol, pre";
export const FT_BODY_SELECTOR = ".article__content-body, [data-trackable='article-body'], [data-component='article-body']";
export const FT_STANDFIRST_SELECTOR = ".article__standfirst, .o-topper__standfirst, [data-trackable='standfirst'], [data-component='standfirst']";
const EXCLUDED_SELECTOR = [
  "figure",
  "figcaption",
  "aside",
  "[class*='share']",
  "[class*='newsletter']",
  "[class*='promo']",
  "[class*='recommend']",
  "[class*='related']",
  "[class*='advert']",
  "[data-trackable*='share']",
  "[data-trackable*='newsletter']",
  "[data-trackable*='recommend']",
].join(",");
const TERMINAL_HEADING = /^(?:Follow the topics in this article|Comments|Recommended|More from the FT)$/iu;
const UI_TEXT = /(?:\bon (?:x|facebook|linkedin|whatsapp) \(opens in a new window\)|Some content could not load\. Check your internet connection or browser settings\.|selects (?:his|her|their) favourite stories in this .+ newsletter)/iu;
const ACCESS_OFFER_SIGNALS = [
  /complete digital access to quality FT journalism/iu,
  /explore our full range of subscriptions/iu,
  /discover all the plans currently available in your country/iu,
  /digital access for organisations\. Includes exclusive features and content/iu,
];
const PROFESSIONAL_ACCESS_GATE = /activate your \d+ day complimentary access to read this article/iu;
const PROFESSIONAL_SERVICE_OFFER = /premium service available as an addition to an FT Professional subscription/iu;

type FtAccessOfferMarker = "consumer-subscription-offer" | "professional-service-offer";

interface FtAccessOffer {
  marker: FtAccessOfferMarker;
  matchedSignals: number;
}

function normalizedText(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function accessOffer(document: CheerioAPI, elements: FtDocumentElement[]): FtAccessOffer | undefined {
  const text = normalizedText(elements.map((element) => document(element).text()).join(" "));
  const matchedSignals = ACCESS_OFFER_SIGNALS.filter((signal) => signal.test(text)).length;
  if (matchedSignals >= 3) return { marker: "consumer-subscription-offer", matchedSignals };
  if (PROFESSIONAL_ACCESS_GATE.test(text) && PROFESSIONAL_SERVICE_OFFER.test(text)) {
    return { marker: "professional-service-offer", matchedSignals: 2 };
  }
  return undefined;
}

function hasBlockAncestor(element: FtDocumentElement, container: FtDocumentElement): boolean {
  let current = element.parent as FtDocumentElement | undefined;
  while (current && current !== container) {
    if ("tagName" in current && /^(?:p|h2|h3|h4|blockquote|ul|ol|pre)$/iu.test(current.tagName)) return true;
    current = current.parent as FtDocumentElement | undefined;
  }
  return false;
}

function blockElements(
  document: CheerioAPI,
  container: FtDocumentElement,
  stopAtTerminal: boolean,
): { values: FtDocumentElement[]; terminal?: FtDocumentElement } {
  const values: FtDocumentElement[] = [];
  for (const element of document(container).find(BLOCK_SELECTOR).toArray()) {
    const node = document(element);
    if (node.closest(EXCLUDED_SELECTOR).length || hasBlockAncestor(element, container)) continue;
    const text = normalizedText(node.text());
    if (stopAtTerminal && node.is("h2,h3,h4") && TERMINAL_HEADING.test(text)) {
      return { values, terminal: element };
    }
    if (!text || UI_TEXT.test(text)) continue;
    values.push(element);
  }
  return { values };
}

function bestBody(document: CheerioAPI): ReturnType<CheerioAPI> {
  const explicit = document(FT_BODY_SELECTOR).toArray();
  if (explicit.length) {
    const winner = explicit.toSorted((left, right) => document(right).find("p").length - document(left).find("p").length)[0];
    return winner ? document(winner) : document("");
  }
  const content = document("[data-content-id]").toArray()
    .filter((element) => document(element).find("p").length >= 2)
    .toSorted((left, right) => document(right).find("p").length - document(left).find("p").length)[0];
  return content ? document(content) : document("");
}

export interface FtBodyStructure {
  body: ReturnType<CheerioAPI>;
  blockElements: FtDocumentElement[];
  terminal?: FtDocumentElement;
}

type FtBodyInspection =
  | { outcome: "unmatched" }
  | {
      outcome: "access-offer";
      blockElements: FtDocumentElement[];
      location: string;
      offer: FtAccessOffer;
    }
  | { outcome: "article"; structure: FtBodyStructure };

function inspectFtBody(document: CheerioAPI): FtBodyInspection {
  const body = bestBody(document);
  if (!body.length) return { outcome: "unmatched" };
  const standfirst = document(FT_STANDFIRST_SELECTOR).first();
  const bodyResult = blockElements(document, body[0]!, true);
  const offer = accessOffer(document, bodyResult.values);
  if (offer) {
    return {
      outcome: "access-offer",
      blockElements: bodyResult.values,
      location: body.is(FT_BODY_SELECTOR) ? FT_BODY_SELECTOR : "[data-content-id]",
      offer,
    };
  }
  const values = [
    ...(standfirst.length && !standfirst.is(body) ? blockElements(document, standfirst[0]!, false).values : []),
    ...bodyResult.values,
  ];
  return {
    outcome: "article",
    structure: {
      body,
      blockElements: values,
      ...(bodyResult.terminal ? { terminal: bodyResult.terminal } : {}),
    },
  };
}

export function ftBodyStructure(document: CheerioAPI): FtBodyStructure | undefined {
  const inspection = inspectFtBody(document);
  return inspection.outcome === "article" ? inspection.structure : undefined;
}

export function extractFtBody(
  html: string,
  quality: BodyQuality,
  pageUrl?: string,
): string | ArticleBodyExtraction | undefined {
  const document = load(html);
  const inspection = inspectFtBody(document);
  if (inspection.outcome === "unmatched") return undefined;
  if (inspection.outcome === "access-offer") {
    return {
      html: inspection.blockElements.map((element) => document.html(element)).join(""),
      completeness: "truncated",
      evidence: {
        kind: "access-offer",
        marker: inspection.offer.marker,
        location: inspection.location,
        matchedSignals: inspection.offer.matchedSignals,
      },
    };
  }
  const { structure } = inspection;
  return semanticHtmlBlocks(structure.blockElements.map((element) => document.html(element)), quality, pageUrl);
}
