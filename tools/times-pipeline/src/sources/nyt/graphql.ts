import { load } from "cheerio";
import type { CapturedHtmlPage } from "../../capture/http.js";
import { BROWSER_USER_AGENT } from "../../network/headers.js";

const NYT_CONFIG_URL = "https://www.nytimes.com/manifest.json";

const ARTICLE_QUERY = `
query ArticleQuery($id: String!) {
  article: workOrLocation(id: $id) {
    __typename
    ... on Article {
      id
      url
      headline { default }
      summary
      bylines {
        renderedRepresentation
        creators {
          __typename
          ... on Person { id displayName url bioUrl }
        }
      }
      body {
        content {
          __typename
          ... on HeaderBasicBlock {
            ledeMedia {
              __typename
              ... on ImageBlock {
                size
                media { __typename ... on Image { ...ImageFields } }
              }
              ... on InteractiveBlock { ...InteractiveBlockFields }
              ... on SlideshowBlock {
                size
                slideshowMedia: media {
                  __typename
                  ... on Slideshow {
                    id
                    url
                    slides {
                      __typename
                      ... on SlideshowSlide {
                        legacyHtmlCaption
                        image { __typename ... on Image { ...ImageFields } }
                      }
                    }
                  }
                }
              }
              ... on CardDeckBlock {
                media {
                  __typename
                  ... on CardDeck { promotionalMedia { __typename ... on Image { ...ImageFields } } }
                }
              }
            }
          }
          ... on HeaderFullBleedHorizontalBlock {
            ledeMedia {
              __typename
              ... on ImageBlock {
                size
                media { __typename ... on Image { ...ImageFields } }
              }
              ... on InteractiveBlock { ...InteractiveBlockFields }
            }
          }
          ... on HeaderFullBleedVerticalBlock {
            ledeMedia {
              __typename
              ... on ImageBlock {
                size
                media { __typename ... on Image { ...ImageFields } }
              }
              ... on InteractiveBlock { ...InteractiveBlockFields }
            }
          }
          ... on HeaderMultimediaBlock {
            headline {
              __typename
              ... on Heading1Block { content { ...InlineFields } }
            }
            summary {
              __typename
              ... on SummaryBlock { content { ...InlineFields } }
            }
            headerMedia: media {
              __typename
              ... on AudioBlock {
                media {
                  __typename
                  ... on Audio {
                    promotionalMedia { __typename ... on Image { ...ImageFields } }
                  }
                }
              }
            }
          }
          ... on ParagraphBlock {
            textAlign
            content {
              ...InlineFields
            }
          }
          ... on DetailBlock {
            textAlign
            content { ...InlineFields }
          }
          ... on Heading2Block {
            textAlign
            content { ...InlineFields }
          }
          ... on Heading1Block {
            textAlign
            content { ...InlineFields }
          }
          ... on Heading3Block {
            textAlign
            content { ...InlineFields }
          }
          ... on BlockquoteBlock {
            content {
              __typename
              ... on ParagraphBlock {
                textAlign
                content { ...InlineFields }
              }
            }
          }
          ... on RuleBlock { type }
          ... on ListBlock {
            style
            content {
              __typename
              ... on ListItemBlock {
                content {
                  __typename
                  ... on ParagraphBlock {
                    textAlign
                    content { ...InlineFields }
                  }
                }
              }
            }
          }
          ... on ImageBlock {
            size
            media { __typename ... on Image { ...ImageFields } }
          }
          ... on DiptychBlock {
            size
            imageOne { __typename ... on Image { ...ImageFields } }
            imageTwo { __typename ... on Image { ...ImageFields } }
          }
          ... on GridBlock {
            size
            caption
            credit
            gridMedia: media { __typename ... on Image { ...ImageFields } }
          }
          ... on SlideshowBlock {
            size
            slideshowMedia: media {
              __typename
              ... on Slideshow {
                id
                url
                slides {
                  __typename
                  ... on SlideshowSlide {
                    legacyHtmlCaption
                    image { __typename ... on Image { ...ImageFields } }
                  }
                }
              }
            }
          }
          ... on LabelBlock {
            textAlign
            labelContent: content { ...InlineFields }
          }
          ... on BylineBlock {
            textAlign
            role { ...InlineFields }
            bylines {
              prefix
              renderedRepresentation
              creators {
                __typename
                ... on Person { id displayName url bioUrl }
              }
            }
          }
          ... on CapsuleBlock {
            capsuleContent: content {
              __typename
              ... on Capsule {
                body {
                  content {
                    __typename
                    ... on ParagraphBlock { content { ...InlineFields } }
                    ... on DetailBlock { content { ...InlineFields } }
                    ... on Heading2Block { content { ...InlineFields } }
                    ... on Heading3Block { content { ...InlineFields } }
                    ... on RuleBlock { type }
                    ... on ImageBlock { size media { __typename ... on Image { ...ImageFields } } }
                    ... on InteractiveBlock { ...InteractiveBlockFields }
                    ... on HeaderBasicBlock { capsuleLedeMedia: ledeMedia { __typename } }
                    ... on VisualStackBlock {
                      label {
                        __typename
                        ... on ParagraphBlock { content { ...InlineFields } }
                      }
                      heading {
                        __typename
                        ... on Heading2Block { content { ...InlineFields } }
                      }
                      visualContent: content {
                        __typename
                        ... on ParagraphBlock { content { ...InlineFields } }
                      }
                      visualMedia: media {
                        __typename
                        ... on ImageBlock { size media { __typename ... on Image { ...ImageFields } } }
                      }
                    }
                  }
                }
              }
            }
          }
          ... on GroupBlock {
            groupTitle: title
            groupDescription: description
            layout
            groupContent: content {
              __typename
              ... on ParagraphBlock { content { ...InlineFields } }
              ... on DetailBlock { content { ...InlineFields } }
              ... on Heading2Block { content { ...InlineFields } }
              ... on Heading3Block { content { ...InlineFields } }
              ... on RuleBlock { type }
              ... on ImageBlock { size media { __typename ... on Image { ...ImageFields } } }
            }
          }
          ... on UnstructuredBlock {
            dataType
            data
            unstructuredMedia: media {
              __typename
              ... on Image { ...ImageFields }
            }
          }
          ... on VisualStackBlock {
            label {
              __typename
              ... on ParagraphBlock { content { ...InlineFields } }
            }
            heading {
              __typename
              ... on Heading2Block { content { ...InlineFields } }
            }
            visualContent: content {
              __typename
              ... on ParagraphBlock { content { ...InlineFields } }
            }
            visualMedia: media {
              __typename
              ... on ImageBlock { size media { __typename ... on Image { ...ImageFields } } }
            }
          }
          ... on DocumentTearBlock {
            tearTitle: title {
              __typename
              ... on Heading3Block { content { ...InlineFields } }
            }
            tearContent: content {
              __typename
              ... on ParagraphBlock { content { ...InlineFields } }
            }
            tearCaption: caption {
              __typename
              ... on DetailBlock { content { ...InlineFields } }
            }
            tearSource: source {
              __typename
              ... on DetailBlock { content { ...InlineFields } }
            }
            tearMedia: media {
              __typename
            }
          }
          ... on InteractiveBlock { ...InteractiveBlockFields }
        }
      }
    }
  }
}
fragment InlineFields on InlineUnion {
  __typename
  ... on LineBreakInline { type }
  ... on TextInline {
    text
    formats {
      __typename
      ... on BoldFormat { type }
      ... on ItalicFormat { type }
      ... on LinkFormat { url title }
    }
  }
}
fragment InteractiveBlockFields on InteractiveBlock {
  media {
    __typename
    ... on EmbeddedInteractive {
      id
      appName
      storyFormat
      slug
      html
      compatibility
    }
    ... on Interactive {
      id
      headline { default }
      url
      summary
      firstPublished
      sourceApplication
    }
  }
}
fragment ImageFields on Image {
  id
  imageType
  url
  uri
  credit
  legacyHtmlCaption
  altText
  caption { text }
  crops(renditionNames: ["articleLarge", "jumbo", "superJumbo", "popup", "mobileMasterAt3x"]) {
    name
    renditions { url name width height }
  }
}`;

interface NytGraphqlConfig {
  endpoint: string;
  headers: {
    "nyt-app-type": string;
    "nyt-app-version": string;
    "nyt-token": string;
  };
}

interface NytFormat {
  __typename?: string;
  type?: string;
  url?: string;
  title?: string;
}

interface NytInline {
  __typename?: string;
  text?: string;
  formats?: NytFormat[];
}

interface NytRendition {
  url?: string;
  name?: string;
  width?: number;
  height?: number;
}

interface NytImage {
  __typename?: string;
  id?: string;
  url?: string;
  uri?: string;
  credit?: string;
  legacyHtmlCaption?: string;
  altText?: string;
  summary?: string;
  caption?: { text?: string };
  crops?: Array<{ name?: string; renditions?: NytRendition[] }>;
}

interface NytImageBlock {
  __typename?: string;
  media?: NytImage;
}

interface NytParagraphBlock {
  __typename?: string;
  content?: NytInline[];
}

interface NytListItemBlock {
  __typename?: string;
  content?: NytParagraphBlock[];
}

interface NytInteractiveMedia {
  __typename?: string;
  id?: string;
  appName?: string;
  compatibility?: string;
  firstPublished?: string;
  headline?: { default?: string };
  html?: string;
  slug?: string;
  storyFormat?: string;
  sourceApplication?: string;
  summary?: string;
  url?: string;
}

interface NytSlideshowSlide {
  __typename?: string;
  legacyHtmlCaption?: string;
  image?: NytImage;
  media?: NytImage | { __typename?: string };
}

interface NytSlideshowMedia {
  __typename?: string;
  id?: string;
  url?: string;
  slides?: NytSlideshowSlide[];
}

interface NytPromotionalMedia {
  __typename?: string;
  promotionalMedia?: NytImage;
}

interface NytByline {
  prefix?: string;
  renderedRepresentation?: string;
  role?: NytInline[];
  creators?: Array<{
    __typename?: string;
    displayName?: string;
    url?: string;
    bioUrl?: string;
  }>;
}

interface NytHeaderMediaBlock {
  __typename?: string;
  media?: {
    __typename?: string;
    promotionalMedia?: NytImage;
  };
}

interface NytBodyBlock {
  __typename?: string;
  content?: Array<NytInline | NytParagraphBlock | NytListItemBlock>;
  labelContent?: NytInline[];
  groupContent?: NytBodyBlock[];
  groupTitle?: string;
  groupDescription?: string;
  capsuleContent?: NytCapsule | NytCapsule[];
  capsuleLedeMedia?: { __typename?: string };
  visualContent?: NytParagraphBlock[];
  visualMedia?: NytBodyBlock;
  label?: NytParagraphBlock;
  heading?: NytParagraphBlock;
  tearTitle?: NytParagraphBlock;
  tearContent?: NytParagraphBlock[];
  tearCaption?: NytParagraphBlock;
  tearSource?: NytParagraphBlock;
  tearMedia?: NytBodyBlock;
  imageOne?: NytImage;
  imageTwo?: NytImage;
  ledeMedia?: NytImageBlock | NytBodyBlock;
  media?: NytImage | NytInteractiveMedia | NytSlideshowMedia | NytPromotionalMedia;
  gridMedia?: NytImage[];
  slideshowMedia?: NytSlideshowMedia | NytSlideshowMedia[];
  unstructuredMedia?: Array<NytImage | { __typename?: string }>;
  headerMedia?: NytHeaderMediaBlock | NytHeaderMediaBlock[];
  headline?: { __typename?: string; content?: NytInline[] };
  summary?: { __typename?: string; content?: NytInline[] };
  caption?: string;
  credit?: string;
  data?: unknown;
  dataType?: string;
  prefix?: string;
  renderedRepresentation?: string;
  role?: NytInline[];
  bylines?: NytByline[];
  style?: string;
  type?: string;
}

interface NytCapsule {
  __typename?: string;
  body?: { content?: NytBodyBlock[] };
}

interface RenderContext {
  slideshowIndex: number;
}

interface NytArticle {
  __typename?: string;
  headline?: { default?: string };
  summary?: string;
  bylines?: NytByline[];
  body?: { content?: NytBodyBlock[] };
}

interface NytGraphqlResponse {
  data?: { article?: NytArticle | null };
  errors?: unknown[];
}

let configPromise: Promise<NytGraphqlConfig> | undefined;

const KNOWN_NON_ARTICLE_BLOCKS = new Set([
  "CommentsBlock",
  "EmailSignupBlock",
  "RelatedLinksBlock",
]);

const KNOWN_NON_TEXT_MEDIA_BLOCKS = new Set([
  "AudioBlock",
  "VideoBlock",
]);

// These Runway embeds were inspected against the publisher HTML served by the
// current five-day corpus. Their server-rendered markup is meaningful, but raw
// root text is not a stable completeness signal because responsive artboards
// repeat labels and accessible image descriptions live in hidden DOM nodes.
// Future slugs keep the stricter generic path below.
const AUDITED_RUNWAY_SEMANTIC_SLUGS = new Set([
  "2026-08-27-ireland-castle-map-IRELAND-CASTLEmap",
  "2026-08-28-liberia-deportation-map-liberia-deportation-flight",
  "2026-08-28-nepal-glacier-beforeafter",
  "cli-glacier-failures-map",
  "cushing-map",
  "dahlias-1",
  "dahlias-2",
  "dahlias-3",
  "diagram-midtown-damage-plans",
  "glacial-lakes-map",
  "messages1787082277873",
  "paid-influence-dash",
  "paid-influencer-stepper-1",
  "paid-influencers-paige",
  "tennis-attendance-tennis-attendance",
]);

const DYNAMIC_RUNWAY_SLUGS = new Set([
  "27wea-radar-nyc",
  "cushing-oil-charts",
  "mt-bldgs-map",
  "mt-bldgs-table",
  "mt-bldgs-timeline",
]);

const AUDITED_PAID_VIDEO_SLUGS = new Set([
  "paid-influence-dash",
  "paid-influencer-stepper-1",
  "paid-influencers-paige",
]);

const AUDITED_DAHLIA_RUNWAY_SLUGS = new Set([
  "dahlias-1",
  "dahlias-2",
  "dahlias-3",
]);

const CAPSULE_QUERIED_BLOCKS = new Set([
  "DetailBlock",
  "Heading2Block",
  "Heading3Block",
  "ImageBlock",
  "InteractiveBlock",
  "ParagraphBlock",
  "RuleBlock",
  "VisualStackBlock",
]);

const GROUP_QUERIED_BLOCKS = new Set([
  "DetailBlock",
  "Heading2Block",
  "Heading3Block",
  "ImageBlock",
  "ParagraphBlock",
  "RuleBlock",
]);

class NytGraphqlCompletenessError extends Error {}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function normalizedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replaceAll(/\s+/gu, " ").trim();
  return text || undefined;
}

function safeUrl(value: unknown, baseUrl: string): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value, baseUrl);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function array<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function warnFallback(pageUrl: string, message: string): void {
  console.warn(`[nyt-graphql] ${message}; falling back to generic capture: ${pageUrl}`);
}

function failCompleteness(message: string): never {
  throw new NytGraphqlCompletenessError(message);
}

function objectAfterKey(html: string, key: string, after = 0): Record<string, unknown> | undefined {
  const keyIndex = html.indexOf(`"${key}"`, after);
  if (keyIndex < 0) return undefined;
  const start = html.indexOf("{", keyIndex + key.length + 2);
  if (start < 0) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, index + 1)) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function parseNytGraphqlConfig(html: string): NytGraphqlConfig | undefined {
  const preloaded = html.indexOf("window.__preloadedData");
  if (preloaded < 0) return undefined;
  const endpointKey = html.indexOf('"gqlUrlClient"', preloaded);
  const endpointStart = endpointKey < 0 ? -1 : html.indexOf('"', html.indexOf(":", endpointKey) + 1);
  let endpoint: string | undefined;
  if (endpointStart >= 0) {
    let escaped = false;
    for (let index = endpointStart + 1; index < html.length; index += 1) {
      const character = html[index]!;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') {
        try {
          endpoint = JSON.parse(html.slice(endpointStart, index + 1)) as string;
        } catch {
          endpoint = undefined;
        }
        break;
      }
    }
  }
  // The surrounding preloaded config contains JavaScript `undefined` values,
  // but these request headers are a standalone JSON object.
  const rawHeaders = objectAfterKey(html, "gqlRequestHeaders", preloaded);
  const appType = typeof rawHeaders?.["nyt-app-type"] === "string" ? rawHeaders["nyt-app-type"] : undefined;
  const appVersion = typeof rawHeaders?.["nyt-app-version"] === "string" ? rawHeaders["nyt-app-version"] : undefined;
  const token = typeof rawHeaders?.["nyt-token"] === "string" ? rawHeaders["nyt-token"] : undefined;
  if (!endpoint || !appType || !appVersion || !token) return undefined;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".nytimes.com")) return undefined;
  } catch {
    return undefined;
  }
  return {
    endpoint,
    headers: {
      "nyt-app-type": appType,
      "nyt-app-version": appVersion,
      "nyt-token": token,
    },
  };
}

async function loadGraphqlConfig(fetchImpl: typeof fetch, timeoutSeconds: number): Promise<NytGraphqlConfig> {
  const response = await fetchImpl(NYT_CONFIG_URL, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": BROWSER_USER_AGENT,
    },
    signal: AbortSignal.timeout(timeoutSeconds * 1_000),
  });
  const config = parseNytGraphqlConfig(await response.text());
  if (!config) throw new Error("NytGraphqlConfigNotFound");
  return config;
}

async function graphqlConfig(fetchImpl: typeof fetch, timeoutSeconds: number): Promise<NytGraphqlConfig> {
  configPromise ??= loadGraphqlConfig(fetchImpl, timeoutSeconds).catch((error: unknown) => {
    configPromise = undefined;
    throw error;
  });
  return configPromise;
}

function renderInline(inline: NytInline, pageUrl: string): string {
  if (inline.__typename === "LineBreakInline") return "<br>";
  if (inline.__typename !== "TextInline" || typeof inline.text !== "string") {
    return failCompleteness(`unsupported inline ${inline.__typename ?? "without typename"}`);
  }
  let html = escapeHtml(inline.text);
  for (const format of array(inline.formats)) {
    if (format.__typename === "BoldFormat") html = `<strong>${html}</strong>`;
    else if (format.__typename === "ItalicFormat") html = `<em>${html}</em>`;
    else if (format.__typename === "SuperscriptFormat") html = `<sup>${html}</sup>`;
    else if (format.__typename === "SubscriptFormat") html = `<sub>${html}</sub>`;
    // Drop caps change presentation only; keeping the publisher text verbatim is
    // semantically complete and avoids inventing article-level styling.
    else if (format.__typename === "DropcapFormat") continue;
    else if (format.__typename === "LinkFormat") {
      const href = safeUrl(format.url, pageUrl);
      const title = normalizedText(format.title);
      if (href) html = `<a href="${escapeAttribute(href)}"${title ? ` title="${escapeAttribute(title)}"` : ""}>${html}</a>`;
    } else return failCompleteness(`unsupported inline format ${format.__typename ?? "without typename"}`);
  }
  return html;
}

function renderInlineContent(
  content: NytInline[] | undefined,
  _blockType: string,
  pageUrl: string,
): string | undefined {
  const values = array(content);
  if (!values.length) return undefined;
  const html = values.map((inline) => renderInline(inline, pageUrl)).join("");
  return normalizedText(load(html, undefined, false).root().text()) ? html : undefined;
}

function renderTextBlock(
  block: Pick<NytBodyBlock, "content" | "__typename"> | NytParagraphBlock,
  tag: "h2" | "h3" | "p",
  pageUrl: string,
  attributes = "",
): string | undefined {
  const html = renderInlineContent(block.content as NytInline[] | undefined, block.__typename ?? tag, pageUrl);
  return html ? `<${tag}${attributes}>${html}</${tag}>` : undefined;
}

function renderBlockquote(block: NytBodyBlock, pageUrl: string): string | undefined {
  const content = array(block.content);
  const paragraphs: string[] = [];
  for (const child of content) {
    if (child.__typename !== "ParagraphBlock") {
      return failCompleteness(`BlockquoteBlock contains unsupported child ${child.__typename ?? "without typename"}`);
    }
    const paragraph = renderTextBlock(child as NytParagraphBlock, "p", pageUrl);
    if (paragraph) paragraphs.push(paragraph);
  }
  return paragraphs.length ? `<blockquote>${paragraphs.join("")}</blockquote>` : undefined;
}

function renderList(block: NytBodyBlock, pageUrl: string): string | undefined {
  const items: string[] = [];
  for (const value of array(block.content)) {
    if (value.__typename !== "ListItemBlock") {
      return failCompleteness(`ListBlock contains unsupported child ${value.__typename ?? "without typename"}`);
    }
    const paragraphs = array((value as NytListItemBlock).content).flatMap((paragraph) => {
      if (paragraph.__typename !== "ParagraphBlock") {
        return failCompleteness(`ListItemBlock contains unsupported child ${paragraph.__typename ?? "without typename"}`);
      }
      const html = renderInlineContent(paragraph.content, "ListItemBlock", pageUrl);
      return html ? [html] : [];
    });
    if (paragraphs.length) items.push(`<li>${paragraphs.join("<br>")}</li>`);
  }
  if (!items.length) return undefined;
  const tag = /(?:number|order)/iu.test(block.style ?? "") ? "ol" : "ul";
  return `<${tag}>${items.join("")}</${tag}>`;
}

function imageRendition(image: NytImage, pageUrl: string): (NytRendition & { url: string }) | undefined {
  const priority = new Map([
    ["superJumbo", 5],
    ["jumbo", 4],
    ["articleLarge", 3],
    ["mobileMasterAt3x", 2],
    ["popup", 1],
  ]);
  const candidates = array(image.crops).flatMap((crop) => array(crop.renditions).map((rendition) => ({
    ...rendition,
    cropName: crop.name,
  }))).flatMap((rendition) => {
    const url = safeUrl(rendition.url, pageUrl);
    return url ? [{ ...rendition, url }] : [];
  });
  const selected = candidates.toSorted((left, right) => {
    const rightPriority = priority.get(right.name ?? right.cropName ?? "") ?? 0;
    const leftPriority = priority.get(left.name ?? left.cropName ?? "") ?? 0;
    return rightPriority - leftPriority || (right.width ?? 0) - (left.width ?? 0);
  })[0];
  if (selected) return selected;
  const url = safeUrl(image.url ?? image.uri, pageUrl);
  return url ? { url } : undefined;
}

function legacyCaptionText(value: unknown): string | undefined {
  return typeof value === "string" ? normalizedText(load(value, undefined, false).root().text()) : undefined;
}

function renderImageMedia(
  image: NytImage | undefined,
  pageUrl: string,
  attributes = "",
  captionOverride?: string,
  creditOverride?: string,
): string | undefined {
  if (!image || image.__typename !== "Image") return undefined;
  const rendition = imageRendition(image, pageUrl);
  if (!rendition) return undefined;
  const alt = normalizedText(image.altText);
  const caption = normalizedText(image.caption?.text) ?? legacyCaptionText(image.legacyHtmlCaption) ?? normalizedText(captionOverride);
  const credit = normalizedText(image.credit) ?? normalizedText(creditOverride);
  const imageAttributes = [
    `src="${escapeAttribute(rendition.url)}"`,
    alt ? `alt="${escapeAttribute(alt)}"` : 'alt=""',
    typeof rendition.width === "number" && rendition.width > 0 ? `width="${rendition.width}"` : undefined,
    typeof rendition.height === "number" && rendition.height > 0 ? `height="${rendition.height}"` : undefined,
  ].filter(Boolean).join(" ");
  const figcaption = caption || credit
    ? `<figcaption>${caption ? `<span>${escapeHtml(caption)}</span>` : ""}${credit ? `<span data-testid="image-credit">${escapeHtml(credit)}</span>` : ""}</figcaption>`
    : "";
  return `<figure data-nyt-official-image="true"${attributes}><img ${imageAttributes}>${figcaption}</figure>`;
}

function renderImage(block: NytImageBlock | NytBodyBlock | undefined, pageUrl: string, attributes = ""): string | undefined {
  if (!block || block.__typename !== "ImageBlock" || !block.media || block.media.__typename !== "Image") return undefined;
  return renderImageMedia(block.media as NytImage, pageUrl, attributes);
}

function numericAttribute(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function srcsetUrl(value: unknown, pageUrl: string): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.split(",").map((entry) => entry.trim().split(/\s+/u)[0])
    .flatMap((candidate) => {
      const url = safeUrl(candidate, pageUrl);
      return url ? [url] : [];
    }).at(-1);
}

function datawrapperPreview(value: unknown, pageUrl: string): { embedUrl: string; previewUrl: string } | undefined {
  const embedUrl = safeUrl(value, pageUrl);
  if (!embedUrl) return undefined;
  const parsed = new URL(embedUrl);
  if (parsed.hostname !== "datawrapper.dwcdn.net") return undefined;
  const match = /^\/([A-Za-z0-9_-]+)\/(\d+)\/?$/u.exec(parsed.pathname);
  if (!match) return undefined;
  const [, chartId, version] = match;
  return {
    embedUrl,
    previewUrl: `https://datawrapper.dwcdn.net/${chartId}/plain-s.png?v=${version}`,
  };
}

const EMBEDDED_SEMANTIC_SELECTOR = "p,h1,h2,h3,h4,blockquote,li,figcaption";

function auditedRunwaySlug(media: NytInteractiveMedia): string | undefined {
  return media.appName === "Runway"
    && media.compatibility === "INLINE"
    && media.slug
    && AUDITED_RUNWAY_SEMANTIC_SLUGS.has(media.slug)
    ? media.slug
    : undefined;
}

function normalizeAuditedRunway(
  document: ReturnType<typeof load>,
  media: NytInteractiveMedia,
): string | undefined {
  const slug = auditedRunwaySlug(media);
  if (!slug) return undefined;

  if (AUDITED_DAHLIA_RUNWAY_SLUGS.has(slug)) {
    const imageUrls = document("img").toArray().flatMap((element) => {
      const url = embeddedImageUrl(document, document(element), "https://www.nytimes.com/");
      return url ? [url] : [];
    });
    const safeImages = imageUrls.length === 5
      && new Set(imageUrls).size === 5
      && imageUrls.every((value) => {
        const parsed = new URL(value);
        return parsed.protocol === "https:"
          && parsed.hostname === "static01.nyt.com"
          && /\.(?:jpe?g|png|webp)$/iu.test(parsed.pathname);
      });
    const video = document("video.g-videoplayer");
    if (
      document("script").length !== 2
      || document("script[data-attr='nyt-asset-manifest']").length !== 1
      || document("style").length !== 1
      || !safeImages
      || video.length !== 1
      || !video.is("[muted][loop][playsinline][preload='none']")
      || document(`${EMBEDDED_SEMANTIC_SELECTOR},svg,canvas,audio,form,object,embed,button,input,textarea,select,iframe`).length
    ) return "unexpected dahlias media structure";
  }

  // ai2html/Figma exports contain mutually exclusive responsive artboards.
  // Keep the publisher's largest static variant instead of emitting every
  // CSS breakpoint as if it were a separate editorial image.
  for (const rootElement of document(".ai2html").toArray()) {
    const root = document(rootElement);
    const artboards = root.find(".g-artboard").toArray().filter((element) => document(element).find("img").length > 0);
    if (artboards.length <= 1) continue;
    const light = artboards.find((element) => /(?:^|[-_])light(?:[-_]|$)/iu.test(document(element).attr("id") ?? ""));
    const selected = light ?? [...artboards].sort((left, right) => {
      const leftMinimum = numericAttribute(document(left).attr("data-min-width")) ?? 0;
      const rightMinimum = numericAttribute(document(right).attr("data-min-width")) ?? 0;
      return rightMinimum - leftMinimum;
    })[0];
    for (const artboard of artboards) if (artboard !== selected) document(artboard).remove();
  }
  for (const rootElement of document(".figma2html").toArray()) {
    const root = document(rootElement);
    const figures = root.children("figure").toArray().filter((element) => document(element).find("img").length > 0);
    if (figures.length <= 1) continue;
    const selected = [...figures].sort((left, right) => {
      const leftWidth = numericAttribute(document(left).find("img").first().attr("width")) ?? 0;
      const rightWidth = numericAttribute(document(right).find("img").first().attr("width")) ?? 0;
      return rightWidth - leftWidth;
    })[0];
    for (const figure of figures) if (figure !== selected) document(figure).remove();
  }

  if (AUDITED_PAID_VIDEO_SLUGS.has(slug)) {
    for (const buttonElement of document("button").toArray()) {
      const button = document(buttonElement);
      const phoneScreen = button.closest(".phone-screen[role='presentation']");
      if (
        button.attr("type") !== "button"
        || !button.hasClass("mute-button")
        || button.attr("aria-label") !== "Unmute video"
        || !phoneScreen.length
        || !phoneScreen.find("video").length
      ) {
        return "unexpected paid-video control";
      }
      button.remove();
    }
    document("img.phone-frame,img.video-meta__location-icon").remove();

    for (const captionElement of document(".row-caption").toArray()) {
      const caption = document(captionElement);
      const contents = caption.contents().toArray();
      const firstParagraph = contents.findIndex((node) => node.type === "tag" && node.tagName.toLowerCase() === "p");
      const prefix = firstParagraph < 0 ? contents : contents.slice(0, firstParagraph);
      const prefixHtml: string[] = [];
      for (const node of prefix) {
        if (node.type === "comment") continue;
        if (node.type === "text") prefixHtml.push(escapeHtml(node.data));
        else if (node.type === "tag" && node.tagName.toLowerCase() === "strong") {
          prefixHtml.push(`<strong>${escapeHtml(document(node).text())}</strong>`);
        } else if (normalizedText(document(node).text())) return "unexpected paid-video caption markup";
      }
      const prefixText = normalizedText(load(prefixHtml.join(""), undefined, false).root().text());
      if (!prefixText) continue;
      for (const node of prefix) document(node).remove();
      caption.prepend(`<p data-nyt-runway-caption="true">${prefixHtml.join("")}</p>`);
    }
  }

  return undefined;
}

function describedImageText(
  document: ReturnType<typeof load>,
  image: ReturnType<ReturnType<typeof load>>,
): string | undefined {
  const describedBy = image.closest("[role='img'][aria-describedby]").attr("aria-describedby");
  return describedBy ? normalizedText(document(`#${describedBy}`).first().text()) : undefined;
}

function embeddedImageUrl(
  document: ReturnType<typeof load>,
  image: ReturnType<ReturnType<typeof load>>,
  pageUrl: string,
): string | undefined {
  const pictureSources = image.closest("picture").find("source[srcset],source[data-srcset]").toArray().sort((left, right) => {
    const leftWidth = numericAttribute(document(left).attr("width")) ?? 0;
    const rightWidth = numericAttribute(document(right).attr("width")) ?? 0;
    return rightWidth - leftWidth;
  });
  for (const source of pictureSources) {
    const url = srcsetUrl(document(source).attr("data-srcset") ?? document(source).attr("srcset"), pageUrl);
    if (url) return url;
  }
  return safeUrl(image.attr("data-src") ?? image.attr("src"), pageUrl)
    ?? srcsetUrl(image.attr("data-srcset") ?? image.attr("srcset"), pageUrl);
}

function renderEmbeddedInteractive(html: string, pageUrl: string, media?: NytInteractiveMedia): string | undefined {
  const document = load(html, undefined, false);
  const normalizationError = media ? normalizeAuditedRunway(document, media) : undefined;
  if (normalizationError) return failCompleteness(`EmbeddedInteractive ${media?.appName ?? "without appName"}/${media?.slug ?? "without slug"} has ${normalizationError}`);
  document("script,style,link,noscript,form,svg,canvas,video,audio,button,input,textarea,select,object,embed").remove();
  const allowed = new Set(["a", "b", "blockquote", "br", "code", "em", "i", "li", "p", "s", "strong", "sub", "sup", "u"]);
  const values: string[] = [];
  const seenImages = new Set<string>();
  const seenText = new Set<string>();

  for (const element of document(`iframe,img,${EMBEDDED_SEMANTIC_SELECTOR},a`).toArray()) {
    const node = document(element);
    if (node.is("a") && node.parents(EMBEDDED_SEMANTIC_SELECTOR).length) continue;
    if (!node.is("iframe,img,a") && node.parents(EMBEDDED_SEMANTIC_SELECTOR).length) continue;
    if (node.is("iframe")) {
      const preview = datawrapperPreview(node.attr("src"), pageUrl);
      if (!preview || seenImages.has(preview.previewUrl)) continue;
      seenImages.add(preview.previewUrl);
      const alt = normalizedText(node.attr("title")) ?? "New York Times interactive chart";
      values.push(`<figure data-nyt-interactive="true" data-nyt-datawrapper="true"><a href="${escapeAttribute(preview.embedUrl)}"><img src="${escapeAttribute(preview.previewUrl)}" alt="${escapeAttribute(alt)}"></a></figure>`);
      continue;
    }
    if (node.is("img")) {
      const sourceUrl = embeddedImageUrl(document, node, pageUrl);
      if (!sourceUrl || seenImages.has(sourceUrl)) continue;
      seenImages.add(sourceUrl);
      const alt = normalizedText(node.attr("alt")) ?? describedImageText(document, node);
      const width = numericAttribute(node.attr("width"));
      const height = numericAttribute(node.attr("height"));
      values.push([
        '<figure data-nyt-interactive="true"><img',
        ` src="${escapeAttribute(sourceUrl)}"`,
        ` alt="${escapeAttribute(alt ?? "")}"`,
        width ? ` width="${width}"` : "",
        height ? ` height="${height}"` : "",
        "></figure>",
      ].join(""));
      continue;
    }

    const clone = node.clone();
    clone.find("img").remove();
    for (const descendant of clone.find("*").toArray().reverse()) {
      const child = clone.find(descendant).first();
      if (!("tagName" in descendant)) continue;
      const tag = descendant.tagName.toLowerCase();
      if (!allowed.has(tag)) {
        child.replaceWith(child.contents());
        continue;
      }
      const href = tag === "a" ? safeUrl(child.attr("href"), pageUrl) : undefined;
      const title = tag === "a" ? normalizedText(child.attr("title")) : undefined;
      for (const name of Object.keys(descendant.attribs)) child.removeAttr(name);
      if (href) child.attr({ href, ...(title ? { title } : {}) });
      else if (tag === "a") child.replaceWith(child.contents());
    }
    const text = normalizedText(clone.text());
    if (!text || seenText.has(text)) continue;
    seenText.add(text);
    const inner = clone.html() ?? escapeHtml(text);
    const tag = node.is("h1,h2") ? "h2" : node.is("h3,h4") ? "h3" : node.is("blockquote") ? "blockquote" : node.is("li") ? "li" : "p";
    values.push(`<${tag} data-nyt-interactive="true">${inner}</${tag}>`);
  }

  if (!values.length) {
    document("iframe").remove();
    const text = normalizedText(document.root().text());
    if (text) values.push(`<p data-nyt-interactive="true">${escapeHtml(text)}</p>`);
  }
  return values.length ? values.join("") : undefined;
}

function renderInteractive(block: NytBodyBlock, pageUrl: string): string | undefined {
  const media = block.media as NytInteractiveMedia | undefined;
  if (!media) return undefined;
  if (media.__typename === "EmbeddedInteractive" && typeof media.html === "string") {
    return renderEmbeddedInteractive(media.html, pageUrl, media);
  }
  if (media.__typename === "Interactive") {
    const headline = normalizedText(media.headline?.default);
    const summary = normalizedText(media.summary);
    const href = safeUrl(media.url, pageUrl);
    const linkedHeadline = headline && href
      ? `<a href="${escapeAttribute(href)}">${escapeHtml(headline)}</a>`
      : headline ? escapeHtml(headline) : href ? `<a href="${escapeAttribute(href)}">${escapeHtml(href)}</a>` : "";
    const text = [linkedHeadline, summary ? escapeHtml(summary) : ""].filter(Boolean).join(" ");
    return text ? `<p data-nyt-interactive="true">${text}</p>` : undefined;
  }
  return undefined;
}

function isAuditedEmbeddedPlaceholder(media: NytInteractiveMedia): boolean {
  if (typeof media.html !== "string" || !media.html.trim()) return false;
  const document = load(media.html, undefined, false);
  if (
    media.appName === "Attribute"
    && media.compatibility === "INLINE"
    && ["how-did-this-happen", "metropolitan-diary-submissions"].includes(media.slug ?? "")
  ) {
    document("script,link,style").remove();
    const form = document("div#formpreview[data-formdata]");
    return form.length === 1
      && document("*").length === 1
      && form.children().length === 0
      && !normalizedText(document.root().text());
  }
  if (
    media.appName === ""
    && media.slug === "metropolitandiary-imagesalignment"
    && media.compatibility === "INLINE"
  ) {
    document("script,link,style").remove();
    return document("*").length === 0 && !normalizedText(document.root().text());
  }
  return false;
}

function interactiveMediaIsEmpty(media: NytInteractiveMedia): boolean {
  return ![
    media.id,
    media.appName,
    media.compatibility,
    media.firstPublished,
    media.headline?.default,
    media.html,
    media.slug,
    media.storyFormat,
    media.sourceApplication,
    media.summary,
    media.url,
  ].some((value) => normalizedText(value));
}

function unsupportedEmbeddedElement(media: NytInteractiveMedia, pageUrl: string): string | undefined {
  if (
    media.appName === "Runway"
    && media.compatibility === "INLINE"
    && DYNAMIC_RUNWAY_SLUGS.has(media.slug ?? "")
  ) return "a client-rendered visual without a complete static representation";
  if (media.appName === "Runway" && media.compatibility === "INLINE" && !auditedRunwaySlug(media)) {
    return "an unaudited Runway visual";
  }
  const document = load(media.html ?? "", undefined, false);
  const normalizationError = normalizeAuditedRunway(document, media);
  if (normalizationError) return normalizationError;
  for (const element of document("iframe").toArray()) {
    if (!datawrapperPreview(document(element).attr("src"), pageUrl)) return "iframe";
  }
  const unsupported = document("svg,canvas,audio,form,object,embed,button,input,textarea,select").first();
  return unsupported.length ? unsupported.get(0)?.tagName?.toLowerCase() ?? "visual element" : undefined;
}

function embeddedVisibleText(html: string): string | undefined {
  const document = load(html, undefined, false);
  document("script,style,link,noscript,iframe,video,source,track").remove();
  return normalizedText(document.root().text());
}

interface EmbeddedSemanticSnapshot {
  units: string[];
  leftover?: string;
  error?: string;
}

function embeddedSemanticSnapshot(
  html: string,
  pageUrl: string,
  media: NytInteractiveMedia,
  normalizePublisherHtml = true,
): EmbeddedSemanticSnapshot {
  const document = load(html, undefined, false);
  const normalizationError = normalizePublisherHtml ? normalizeAuditedRunway(document, media) : undefined;
  if (normalizationError) return { units: [], error: normalizationError };
  document("script,style,link,noscript,form,svg,canvas,video,audio,button,input,textarea,select,object,embed").remove();
  const describedIds = new Set<string>();
  const units: string[] = [];
  const seenImages = new Set<string>();
  const seenText = new Set<string>();
  let error: string | undefined;

  for (const element of document(`iframe,img,${EMBEDDED_SEMANTIC_SELECTOR},a`).toArray()) {
    const node = document(element);
    if (node.is("a") && node.parents(EMBEDDED_SEMANTIC_SELECTOR).length) continue;
    if (!node.is("iframe,img,a") && node.parents(EMBEDDED_SEMANTIC_SELECTOR).length) continue;
    if (node.is("iframe")) {
      const preview = datawrapperPreview(node.attr("src"), pageUrl);
      if (!preview) {
        error = "unsupported iframe";
        break;
      }
      if (seenImages.has(preview.previewUrl)) continue;
      seenImages.add(preview.previewUrl);
      const alt = normalizedText(node.attr("title")) ?? "New York Times interactive chart";
      units.push(`image:${preview.previewUrl}\u0000${alt}`);
      continue;
    }
    if (node.is("img")) {
      const sourceUrl = embeddedImageUrl(document, node, pageUrl);
      if (!sourceUrl) {
        error = "image without a safe source";
        break;
      }
      const describedBy = node.closest("[role='img'][aria-describedby]").attr("aria-describedby");
      if (describedBy) describedIds.add(describedBy);
      if (seenImages.has(sourceUrl)) continue;
      seenImages.add(sourceUrl);
      const alt = normalizedText(node.attr("alt")) ?? describedImageText(document, node) ?? "";
      units.push(`image:${sourceUrl}\u0000${alt}`);
      continue;
    }
    const clone = node.clone();
    clone.find("img").remove();
    const text = normalizedText(clone.text());
    if (!text || seenText.has(text)) continue;
    seenText.add(text);
    units.push(`text:${text}`);
  }

  for (const id of describedIds) {
    for (const element of document("[id]").toArray()) {
      if (document(element).attr("id") === id) document(element).remove();
    }
  }
  document(`${EMBEDDED_SEMANTIC_SELECTOR},img,iframe,a,source,track`).remove();
  const leftover = normalizedText(document.root().text());
  return {
    units,
    ...(leftover ? { leftover } : {}),
    ...(error ? { error } : {}),
  };
}

function embeddedContainsOnlySkippedVideo(html: string, media: NytInteractiveMedia): boolean {
  const document = load(html, undefined, false);
  if (normalizeAuditedRunway(document, media)) return false;
  if (!document("video").length) return false;
  document("script,style,link,noscript,video,source,track").remove();
  return !document("img,iframe,svg,canvas,audio,form,object,embed,button,input,textarea,select").length
    && !normalizedText(document.root().text());
}

function renderAuditedInteractive(block: NytBodyBlock, pageUrl: string): string | undefined {
  const media = block.media as NytInteractiveMedia | undefined;
  if (!media) return undefined;
  if (media.__typename !== "EmbeddedInteractive" && media.__typename !== "Interactive") {
    return failCompleteness(`InteractiveBlock contains unsupported media ${media.__typename ?? "without typename"}`);
  }

  if (media.__typename === "EmbeddedInteractive") {
    if (isAuditedEmbeddedPlaceholder(media)) return undefined;
    if (typeof media.html !== "string" || !media.html.trim()) {
      if (interactiveMediaIsEmpty(media)) return undefined;
      return failCompleteness(`EmbeddedInteractive ${media.appName ?? "without appName"}/${media.slug ?? "without slug"} is non-empty but has no HTML`);
    }
    const unsupported = unsupportedEmbeddedElement(media, pageUrl);
    if (unsupported) {
      return failCompleteness(`EmbeddedInteractive ${media.appName ?? "without appName"}/${media.slug ?? "without slug"} contains unsupported ${unsupported}`);
    }
    const rendered = renderInteractive(block, pageUrl);
    if (rendered) {
      if (auditedRunwaySlug(media)) {
        const original = embeddedSemanticSnapshot(media.html, pageUrl, media);
        const output = embeddedSemanticSnapshot(rendered, pageUrl, media, false);
        if (
          original.error
          || output.error
          || original.leftover
          || output.leftover
          || original.units.length !== output.units.length
          || original.units.some((unit, index) => unit !== output.units[index])
        ) {
          return failCompleteness(`EmbeddedInteractive ${media.appName ?? "without appName"}/${media.slug ?? "without slug"} could not preserve its audited semantic media sequence`);
        }
      } else {
        const originalText = embeddedVisibleText(media.html);
        const renderedText = normalizedText(load(rendered, undefined, false).root().text());
        if (originalText !== renderedText) {
          return failCompleteness(`EmbeddedInteractive ${media.appName ?? "without appName"}/${media.slug ?? "without slug"} contains text that could not be preserved`);
        }
      }
      return rendered;
    }
    if (embeddedContainsOnlySkippedVideo(media.html, media)) return undefined;
    return failCompleteness(`EmbeddedInteractive ${media.appName ?? "without appName"}/${media.slug ?? "without slug"} has non-empty unrendered HTML`);
  }

  const rendered = renderInteractive(block, pageUrl);
  if (rendered) return rendered;
  if (interactiveMediaIsEmpty(media)) return undefined;
  return failCompleteness("Interactive media has non-empty metadata but no renderable headline, summary, or URL");
}

function renderGrid(block: NytBodyBlock, pageUrl: string): string[] {
  const media = array(block.gridMedia);
  if (!media.length) return failCompleteness("GridBlock has no queried images");
  return media.map((image, index) => {
    if (image.__typename !== "Image") {
      return failCompleteness(`GridBlock contains unsupported media ${image.__typename ?? "without typename"}`);
    }
    const rendered = renderImageMedia(
      image,
      pageUrl,
      ` data-nyt-grid="${index + 1}"`,
      index === 0 ? block.caption : undefined,
      index === 0 ? block.credit : undefined,
    );
    return rendered ?? failCompleteness(`GridBlock contains unusable image ${index + 1}`);
  });
}

function slideshowMediaValues(block: NytBodyBlock): Array<NytImage | NytSlideshowMedia> {
  if (Array.isArray(block.slideshowMedia)) return block.slideshowMedia;
  return block.slideshowMedia ? [block.slideshowMedia] : [];
}

function renderSlideshow(block: NytBodyBlock, pageUrl: string, context: RenderContext): string[] {
  const imageValues: Array<{ image: NytImage; caption?: string }> = [];
  const renderMedia = (media: NytImage | { __typename?: string } | undefined, caption?: string): void => {
    if (!media) return;
    if (media.__typename === "Video" || media.__typename === "VideoBlock") return;
    if (media.__typename !== "Image") {
      failCompleteness(`SlideshowBlock contains unsupported media ${media.__typename ?? "without typename"}`);
    }
    imageValues.push({ image: media as NytImage, ...(caption ? { caption } : {}) });
  };

  for (const media of slideshowMediaValues(block)) {
    if (media.__typename === "Image" || media.__typename === "Video" || media.__typename === "VideoBlock") {
      renderMedia(media);
      continue;
    }
    if (media.__typename !== "Slideshow") {
      failCompleteness(`SlideshowBlock contains unsupported media ${media.__typename ?? "without typename"}`);
    }
    for (const slide of array((media as NytSlideshowMedia).slides)) {
      if (slide.__typename && slide.__typename !== "SlideshowSlide") {
        failCompleteness(`SlideshowBlock contains unsupported slide ${slide.__typename}`);
      }
      renderMedia(slide.image ?? slide.media, legacyCaptionText(slide.legacyHtmlCaption));
    }
  }
  if (!imageValues.length) return [];
  const groupId = `nyt-slideshow-${++context.slideshowIndex}`;
  return imageValues.map(({ image, caption }, order) => {
    const rendered = renderImageMedia(
      image,
      pageUrl,
      ` data-nyt-slideshow-id="${groupId}" data-nyt-slideshow-order="${order}" data-nyt-slideshow-total="${imageValues.length}"`,
      caption,
    );
    return rendered ?? failCompleteness(`SlideshowBlock contains unusable image ${order + 1}`);
  });
}

function renderBylineBlock(block: NytBodyBlock, pageUrl: string): string[] {
  const values: string[] = [];
  for (const byline of array(block.bylines)) {
    const creators = array(byline.creators).flatMap((creator) => {
      const name = normalizedText(creator.displayName);
      if (!name) return [];
      const url = safeUrl(creator.url ?? creator.bioUrl, pageUrl);
      return [url ? `<a href="${escapeAttribute(url)}">${escapeHtml(name)}</a>` : escapeHtml(name)];
    });
    const prefix = normalizedText(byline.prefix);
    const renderedRepresentation = normalizedText(byline.renderedRepresentation);
    const text = creators.length
      ? `${escapeHtml(prefix ?? "By")} ${creators.join(", ")}`
      : renderedRepresentation ? escapeHtml(renderedRepresentation) : undefined;
    // h4 is intentionally used for short embedded bylines: the shared body
    // sanitizer drops sub-20-character paragraphs, which would erase names
    // such as "By Joe Rennison" and their official profile links.
    if (text) values.push(`<h4 data-nyt-block="byline">${text}</h4>`);
  }
  const role = renderInlineContent(block.role, "BylineBlock", pageUrl);
  if (role) values.push(`<h4 data-nyt-block="byline-role">${role}</h4>`);
  return values;
}

function unstructuredData(block: NytBodyBlock): Record<string, unknown> {
  if (typeof block.data === "string") {
    try {
      const parsed = JSON.parse(block.data) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Fail below with the source block type in the diagnostic.
    }
    return failCompleteness(`${block.dataType ?? "UnstructuredBlock"} contains malformed data`);
  }
  if (block.data && typeof block.data === "object" && !Array.isArray(block.data)) {
    return block.data as Record<string, unknown>;
  }
  return {};
}

function hasEmptyUnstructuredEnvelope(data: Record<string, unknown>, dataType: string): boolean {
  return data.type === dataType
    && data.isUnstructured === true
    && Array.isArray(data.content)
    && data.content.length === 0
    && Array.isArray(data.formats)
    && data.formats.length === 0;
}

function renderUnstructured(block: NytBodyBlock, pageUrl: string): string[] {
  if (array(block.unstructuredMedia).length) {
    return failCompleteness(`${block.dataType ?? "UnstructuredBlock"} unexpectedly contains media`);
  }
  const data = unstructuredData(block);
  if (block.dataType === "ExperimentalBlock_AdHint") {
    if (!hasEmptyUnstructuredEnvelope(data, block.dataType)) {
      return failCompleteness("ExperimentalBlock_AdHint contains unexpected content");
    }
    return [];
  }
  if (block.dataType === "ExperimentalBlock_BulletBriefing") {
    if (!hasEmptyUnstructuredEnvelope(data, block.dataType)) {
      return failCompleteness("ExperimentalBlock_BulletBriefing contains unsupported structured content");
    }
    const ledeText = normalizedText(data.ledeText);
    return ledeText ? [`<p data-nyt-block="bullet-briefing">${escapeHtml(ledeText)}</p>`] : [];
  }
  if (block.dataType === "ExperimentalBlock_DocPromo") {
    if (!hasEmptyUnstructuredEnvelope(data, block.dataType)) {
      return failCompleteness("ExperimentalBlock_DocPromo contains unsupported structured content");
    }
    const documentData = data.documentData && typeof data.documentData === "object" && !Array.isArray(data.documentData)
      ? data.documentData as Record<string, unknown>
      : undefined;
    const title = normalizedText(data.title) ?? normalizedText(documentData?.name);
    const href = safeUrl(documentData?.publishPath, pageUrl);
    const summary = normalizedText(data.summary);
    if (!title || !href) return failCompleteness("ExperimentalBlock_DocPromo is missing its official document link");
    const displayStyle = normalizedText(data.displayStyle) ?? "Compact";
    if (displayStyle !== "Compact" && displayStyle !== "Single Page") {
      return failCompleteness(`ExperimentalBlock_DocPromo has unsupported display style ${displayStyle}`);
    }
    const values: string[] = [];
    if (displayStyle === "Single Page") {
      const imageSelection = normalizedText(data.imageSelection) ?? "1";
      const page = Number(imageSelection);
      const pages = Number(documentData?.pages);
      if (!/^\d+$/u.test(imageSelection)
        || !Number.isSafeInteger(page)
        || page < 1
        || (Number.isSafeInteger(pages) && pages > 0 && page > pages)
      ) {
        return failCompleteness("ExperimentalBlock_DocPromo has unsafe or incomplete preview metadata");
      }
      const rawFullImgUrl = normalizedText(documentData?.fullImgUrl);
      let previewUrl: string;
      let fullPreview = false;
      if (rawFullImgUrl) {
        const safeFullImgUrl = safeUrl(rawFullImgUrl, pageUrl);
        const parsed = safeFullImgUrl ? new URL(safeFullImgUrl) : undefined;
        if (
          !parsed
          || parsed.protocol !== "https:"
          || parsed.hostname !== "static01.nyt.com"
          || parsed.username
          || parsed.password
          || parsed.search
          || parsed.hash
          || !/\.(?:avif|gif|jpe?g|png|webp)$/iu.test(parsed.pathname)
        ) {
          return failCompleteness("ExperimentalBlock_DocPromo has an unsafe full preview URL");
        }
        previewUrl = parsed.toString();
        fullPreview = true;
      } else {
        const assetsHost = normalizedText(documentData?.assetsHost);
        const assetsFolder = normalizedText(documentData?.assetsFolder);
        if (
          assetsHost !== "static01.nyt.com"
          || !assetsFolder
          || !/^newsgraphics\/documenttools\/[A-Za-z0-9_-]+\/$/u.test(assetsFolder)
        ) {
          return failCompleteness("ExperimentalBlock_DocPromo has unsafe or incomplete constructed preview metadata");
        }
        previewUrl = `https://${assetsHost}/${assetsFolder}${imageSelection}/output-${imageSelection}.png`;
      }
      values.push(`<figure data-nyt-derived-preview="true" data-nyt-publisher-editorial="true" data-nyt-document-promo="true"${fullPreview ? ' data-nyt-document-promo-full="true"' : ""}><a href="${escapeAttribute(href)}"><img src="${escapeAttribute(previewUrl)}" alt="Thumbnail of page ${page}"></a><figcaption>${escapeHtml(title)}</figcaption></figure>`);
    }
    values.push(`<p data-nyt-block="document-promo"><a href="${escapeAttribute(href)}">${escapeHtml(title)}</a>${summary ? ` ${escapeHtml(summary)}` : ""}</p>`);
    return values;
  }
  return failCompleteness(`unsupported unstructured data type ${block.dataType ?? "without dataType"}`);
}

function capsuleValues(block: NytBodyBlock): NytCapsule[] {
  if (Array.isArray(block.capsuleContent)) return block.capsuleContent;
  return block.capsuleContent ? [block.capsuleContent] : [];
}

function exactInlineText(content: NytInline[] | undefined): string | undefined {
  if (!Array.isArray(content)) return undefined;
  let value = "";
  for (const inline of content) {
    if (inline.__typename === "LineBreakInline") value += "\n";
    else if (inline.__typename === "TextInline" && typeof inline.text === "string") value += inline.text;
    else return undefined;
  }
  return value.replaceAll(/\s+/gu, " ").trim();
}

function isGamesModuleCapsule(children: NytBodyBlock[]): boolean {
  if (children.length !== 3) return false;
  const [header, spacer, visual] = children;
  if (header?.__typename !== "HeaderBasicBlock" || !("capsuleLedeMedia" in header) || header.capsuleLedeMedia != null) return false;
  if (spacer?.__typename !== "ParagraphBlock" || exactInlineText(spacer.content as NytInline[] | undefined) !== "") return false;
  if (visual?.__typename !== "VisualStackBlock" || !("visualMedia" in visual) || visual.visualMedia != null) return false;
  if (visual.label && exactInlineText(visual.label.content) !== "") return false;
  if (visual.heading && exactInlineText(visual.heading.content) !== "") return false;
  const instructions = array(visual.visualContent).map((paragraph) => exactInlineText(paragraph.content));
  return instructions.length === 2
    && instructions[0] === "DO NOT DELETE THIS CAPSULE. It will display a module with links to today’s games."
    && instructions[1] === "Insert a horizontal rule below this capsule.";
}

function renderHeaderMultimedia(block: NytBodyBlock, pageUrl: string): string | undefined {
  const media = Array.isArray(block.headerMedia) ? block.headerMedia : block.headerMedia ? [block.headerMedia] : [];
  let lead: string | undefined;
  for (const value of media) {
    if (value.__typename === "VideoBlock") continue;
    if (value.__typename === "AudioBlock") {
      const promotionalMedia = value.media?.promotionalMedia;
      if (promotionalMedia) {
        const image = renderImageMedia(promotionalMedia, pageUrl, ' data-nyt-lead="true" data-nyt-audio-promo="true"');
        if (!image) failCompleteness("HeaderMultimediaBlock contains an unusable audio promotional image");
        lead ||= image;
      }
      continue;
    }
    failCompleteness(`HeaderMultimediaBlock contains unsupported media ${value.__typename ?? "without typename"}`);
  }
  // The article-level headline and summary are the canonical copies. This
  // block only controls their presentation around audio/video media.
  return lead;
}

function renderVisualStack(block: NytBodyBlock, pageUrl: string): string[] {
  const values: string[] = [];
  if (block.label) {
    if (block.label.__typename !== "ParagraphBlock") {
      return failCompleteness(`VisualStackBlock contains unsupported label ${block.label.__typename ?? "without typename"}`);
    }
    const label = renderInlineContent(block.label.content, "VisualStackBlock label", pageUrl);
    if (label) values.push(`<h3 data-nyt-block="visual-label">${label}</h3>`);
  }
  if (block.heading) {
    if (block.heading.__typename !== "Heading2Block") {
      return failCompleteness(`VisualStackBlock contains unsupported heading ${block.heading.__typename ?? "without typename"}`);
    }
    const heading = renderInlineContent(block.heading.content, "VisualStackBlock heading", pageUrl);
    if (heading) values.push(`<h2 data-nyt-block="visual-heading">${heading}</h2>`);
  }
  const content = array(block.visualContent).map((paragraph) => {
    if (paragraph.__typename !== "ParagraphBlock") {
      return failCompleteness(`VisualStackBlock contains unsupported content ${paragraph.__typename ?? "without typename"}`);
    }
    return renderInlineContent(paragraph.content, "VisualStackBlock content", pageUrl);
  }).filter((value): value is string => Boolean(value));
  const plainContent = normalizedText(load(content.join(" "), undefined, false).root().text());
  const media = block.visualMedia;
  if (!media) {
    values.push(...content.map((html) => `<p data-nyt-block="visual-caption">${html}</p>`));
    return values;
  }
  if (media.__typename === "VideoBlock") {
    values.push(...content.map((html) => `<p data-nyt-block="visual-caption">${html}</p>`));
    return values;
  }
  if (media.__typename !== "ImageBlock") {
    return failCompleteness(`VisualStackBlock contains unsupported media ${media.__typename ?? "without typename"}`);
  }
  const image = media.media as NytImage | undefined;
  const hasPublisherCaption = normalizedText(image?.caption?.text) ?? legacyCaptionText(image?.legacyHtmlCaption);
  if (hasPublisherCaption) {
    values.push(...content.map((html) => `<p data-nyt-block="visual-caption">${html}</p>`));
  }
  const rendered = renderImageMedia(image, pageUrl, ' data-nyt-visual-stack="true"', plainContent);
  if (!rendered) return failCompleteness("VisualStackBlock contains an unusable image");
  values.push(rendered);
  return values;
}

function renderDocumentTear(block: NytBodyBlock, pageUrl: string): string[] {
  const values: string[] = [];
  if (block.tearTitle) {
    if (block.tearTitle.__typename !== "Heading3Block") {
      return failCompleteness(`DocumentTearBlock contains unsupported title ${block.tearTitle.__typename ?? "without typename"}`);
    }
    const title = renderTextBlock(block.tearTitle, "h3", pageUrl, ' data-nyt-block="document-tear-title"');
    if (title) values.push(title);
  }
  for (const paragraph of array(block.tearContent)) {
    if (paragraph.__typename !== "ParagraphBlock") {
      return failCompleteness(`DocumentTearBlock contains unsupported content ${paragraph.__typename ?? "without typename"}`);
    }
    const html = renderInlineContent(paragraph.content, "DocumentTearBlock content", pageUrl);
    if (html) values.push(`<blockquote data-nyt-block="document-tear"><p>${html}</p></blockquote>`);
  }
  for (const [name, detail] of [["caption", block.tearCaption], ["source", block.tearSource]] as const) {
    if (!detail) continue;
    if (detail.__typename !== "DetailBlock") {
      return failCompleteness(`DocumentTearBlock contains unsupported ${name} ${detail.__typename ?? "without typename"}`);
    }
    const html = renderTextBlock(detail, "p", pageUrl, ` data-nyt-block="document-tear-${name}"`);
    if (html) values.push(html);
  }
  if (block.tearMedia) {
    if (block.tearMedia.__typename === "VideoBlock") return values;
    if (block.tearMedia.__typename !== "ImageBlock") {
      return failCompleteness(`DocumentTearBlock contains unsupported media ${block.tearMedia.__typename ?? "without typename"}`);
    }
    const media = renderImage(block.tearMedia, pageUrl, ' data-nyt-document-tear="true"');
    if (!media) return failCompleteness("DocumentTearBlock contains an unusable image");
    values.push(media);
  }
  return values;
}

function renderStoryBlock(block: NytBodyBlock, pageUrl: string, context: RenderContext): string[] {
  const type = block.__typename ?? "BlockWithoutTypename";
  if (type === "ParagraphBlock") {
    const paragraph = renderTextBlock(block, "p", pageUrl);
    return paragraph ? [paragraph] : [];
  }
  if (type === "DetailBlock") {
    const detail = renderTextBlock(block, "p", pageUrl, ' data-nyt-block="detail"');
    return detail ? [detail] : [];
  }
  if (type === "Heading1Block" || type === "Heading2Block" || type === "Heading3Block") {
    const tag = type === "Heading3Block" ? "h3" : "h2";
    const heading = renderTextBlock(block, tag, pageUrl, type === "Heading1Block" ? ' data-nyt-original-heading="1"' : "");
    return heading ? [heading] : [];
  }
  if (type === "BlockquoteBlock") {
    const quote = renderBlockquote(block, pageUrl);
    return quote ? [quote] : [];
  }
  if (type === "ListBlock") {
    const list = renderList(block, pageUrl);
    return list ? [list] : [];
  }
  if (type === "RuleBlock") return [];
  if (type === "ImageBlock") {
    const image = renderImage(block, pageUrl);
    return image ? [image] : failCompleteness("ImageBlock contains an unusable image");
  }
  if (type === "DiptychBlock") {
    if (Boolean(block.imageOne) !== Boolean(block.imageTwo)) {
      return failCompleteness("DiptychBlock is missing one of its two images");
    }
    return [block.imageOne, block.imageTwo].flatMap((image, index) => {
      if (!image) return [];
      const rendered = renderImageMedia(image, pageUrl, ` data-nyt-diptych="${index + 1}"`);
      return rendered ? [rendered] : failCompleteness(`DiptychBlock contains unusable image ${index + 1}`);
    });
  }
  if (type === "GridBlock") return renderGrid(block, pageUrl);
  if (type === "SlideshowBlock") return renderSlideshow(block, pageUrl, context);
  if (type === "InteractiveBlock") {
    const interactive = renderAuditedInteractive(block, pageUrl);
    // NYT ships empty interactive placeholders in otherwise complete bodies.
    // Safely render every queried field when present, but do not force a
    // paywall fallback when the official object itself carries no content.
    return interactive ? [interactive] : [];
  }
  if (type === "LabelBlock") {
    const label = renderInlineContent(block.labelContent, "LabelBlock", pageUrl);
    return label ? [`<h3 data-nyt-block="label">${label}</h3>`] : [];
  }
  if (type === "BylineBlock") return renderBylineBlock(block, pageUrl);
  if (type === "CapsuleBlock") {
    return capsuleValues(block).flatMap((capsule) => {
      if (capsule.__typename !== "Capsule") {
        return failCompleteness(`CapsuleBlock contains unsupported content ${capsule.__typename ?? "without typename"}`);
      }
      const children = array(capsule.body?.content);
      if (isGamesModuleCapsule(children)) return [];
      return children.flatMap((child) => {
        if (child.__typename === "HeaderBasicBlock") {
          if (!("capsuleLedeMedia" in child) || child.capsuleLedeMedia != null) {
            return failCompleteness("CapsuleBlock contains a non-empty or unqueried HeaderBasicBlock");
          }
          return [];
        }
        if (!child.__typename || !CAPSULE_QUERIED_BLOCKS.has(child.__typename)) {
          return failCompleteness(`CapsuleBlock contains unqueried child ${child.__typename ?? "without typename"}`);
        }
        return renderStoryBlock(child, pageUrl, context);
      });
    });
  }
  if (type === "GroupBlock") {
    const values: string[] = [];
    const title = normalizedText(block.groupTitle);
    const description = normalizedText(block.groupDescription);
    if (title) values.push(`<h3 data-nyt-block="group-title">${escapeHtml(title)}</h3>`);
    if (description) {
      const tag = description.length < 20 ? "h4" : "p";
      values.push(`<${tag} data-nyt-block="group-description">${escapeHtml(description)}</${tag}>`);
    }
    values.push(...array(block.groupContent).flatMap((child) => {
      if (!child.__typename || !GROUP_QUERIED_BLOCKS.has(child.__typename)) {
        return failCompleteness(`GroupBlock contains unqueried child ${child.__typename ?? "without typename"}`);
      }
      return renderStoryBlock(child, pageUrl, context);
    }));
    return values;
  }
  if (type === "UnstructuredBlock") return renderUnstructured(block, pageUrl);
  if (type === "HeaderMultimediaBlock") return [];
  if (type === "VisualStackBlock") return renderVisualStack(block, pageUrl);
  if (type === "DocumentTearBlock") return renderDocumentTear(block, pageUrl);
  if (["HeaderBasicBlock", "HeaderFullBleedHorizontalBlock", "HeaderFullBleedVerticalBlock"].includes(type)) return [];
  if (KNOWN_NON_ARTICLE_BLOCKS.has(type) || KNOWN_NON_TEXT_MEDIA_BLOCKS.has(type)) return [];
  return failCompleteness(`unsupported ${type}`);
}

function creatorLinks(article: NytArticle, pageUrl: string): Array<{ name: string; url: string }> {
  const values = new Map<string, { name: string; url: string }>();
  for (const byline of array(article.bylines)) {
    for (const creator of array(byline.creators)) {
      const name = normalizedText(creator.displayName);
      const url = safeUrl(creator.url ?? creator.bioUrl, pageUrl);
      if (creator.__typename === "Person" && name && url) {
        values.set(`${name}\n${url}`, { name, url });
      }
    }
  }
  return [...values.values()];
}

function renderNytGraphqlArticleHtml(payload: NytGraphqlResponse, pageUrl: string): string | undefined {
  const article = payload.data?.article;
  if (!article || article.__typename !== "Article") return undefined;
  if (Array.isArray(payload.errors) && payload.errors.length) {
    warnFallback(pageUrl, `GraphQL returned ${payload.errors.length} partial error${payload.errors.length === 1 ? "" : "s"}`);
    return undefined;
  }
  const headline = normalizedText(article.headline?.default);
  const blocks = article.body?.content;
  if (!headline || !Array.isArray(blocks) || !blocks.length) return undefined;

  const story: string[] = [];
  const renderContext: RenderContext = { slideshowIndex: 0 };
  let lead = "";
  for (const block of blocks) {
    const type = block.__typename ?? "BlockWithoutTypename";
    if (["HeaderBasicBlock", "HeaderFullBleedHorizontalBlock", "HeaderFullBleedVerticalBlock"].includes(type)) {
      const ledeMedia = block.ledeMedia;
      if (!ledeMedia) continue;
      if (ledeMedia.__typename === "ImageBlock") {
        const image = renderImage(ledeMedia, pageUrl, ' data-nyt-lead="true"');
        if (!image) failCompleteness(`${type} contains an unusable lead image`);
        lead ||= image;
      } else if (ledeMedia.__typename === "InteractiveBlock") {
        const interactive = renderAuditedInteractive(ledeMedia, pageUrl);
        if (interactive) {
          if (normalizedText(load(interactive, undefined, false).root().text())) {
            failCompleteness(`${type} Interactive lead contains visible text that cannot be anchored in the article body`);
          }
          lead ||= interactive;
        }
      } else if (ledeMedia.__typename === "SlideshowBlock") {
        const slideshow = renderSlideshow(ledeMedia, pageUrl, renderContext).join("");
        if (slideshow) lead ||= slideshow;
      } else if (ledeMedia.__typename === "CardDeckBlock") {
        const cardDeck = ledeMedia.media as NytPromotionalMedia | undefined;
        if (cardDeck?.__typename !== "CardDeck") {
          failCompleteness(`${type} contains malformed CardDeck lead media`);
        }
        const promotionalMedia = cardDeck.promotionalMedia;
        if (!promotionalMedia) failCompleteness(`${type} CardDeck lead has no promotional image`);
        const image = renderImageMedia(promotionalMedia, pageUrl, ' data-nyt-lead="true" data-nyt-card-deck="true"');
        if (!image) failCompleteness(`${type} CardDeck lead contains an unusable promotional image`);
        lead ||= image;
      } else if (ledeMedia.__typename === "AudioBlock" || ledeMedia.__typename === "VideoBlock") {
        continue;
      } else {
        failCompleteness(`${type} contains unsupported lede media ${ledeMedia.__typename ?? "without typename"}`);
      }
    } else if (type === "HeaderMultimediaBlock") {
      lead ||= renderHeaderMultimedia(block, pageUrl) ?? "";
    } else {
      story.push(...renderStoryBlock(block, pageUrl, renderContext));
    }
  }
  if (!normalizedText(load(story.join(""), undefined, false).root().text())) return undefined;

  const summary = normalizedText(article.summary);
  const byline = creatorLinks(article, pageUrl);
  const storyText = normalizedText(load(story.join(""), undefined, false).root().text()) ?? "";
  // The live Person.description is a mutable profile, not an article snapshot.
  // Preserve the article-specific creator link without importing that drifting
  // biography when no authored footer is present in body.content.
  const authorAttribution = byline.length && !byline.some((creator) => storyText.includes(creator.name))
    ? `<p data-testid="article-author">By ${byline.map((creator) => `<a href="${escapeAttribute(creator.url)}">${escapeHtml(creator.name)}</a>`).join(", ")}</p>`
    : "";
  return [
    "<!doctype html><html><head>",
    `<meta name="description" content="${escapeAttribute(summary ?? "")}">`,
    "</head><body><main><article>",
    `<h1>${escapeHtml(headline)}</h1>`,
    summary ? `<p id="article-summary">${escapeHtml(summary)}</p>` : "",
    byline.length ? `<p data-testid="byline">By ${byline.map((creator) => `<a href="${escapeAttribute(creator.url)}">${escapeHtml(creator.name)}</a>`).join(", ")}</p>` : "",
    lead,
    `<section name="articleBody">${story.join("")}${authorAttribution}</section>`,
    "</article></main></body></html>",
  ].join("");
}

export function nytGraphqlArticleHtml(payload: NytGraphqlResponse, pageUrl: string): string | undefined {
  try {
    return renderNytGraphqlArticleHtml(payload, pageUrl);
  } catch (error) {
    if (!(error instanceof NytGraphqlCompletenessError)) throw error;
    warnFallback(pageUrl, error.message);
    return undefined;
  }
}

async function validateDerivedPreviews(
  html: string,
  timeoutSeconds: number,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const document = load(html);
  const urls: string[] = [];
  for (const element of document("figure[data-nyt-datawrapper='true'] img,figure[data-nyt-derived-preview='true'] img").toArray()) {
    const figure = document(element).closest("figure");
    const source = safeUrl(document(element).attr("src"), "https://datawrapper.dwcdn.net/");
    if (!source) return false;
    const parsed = new URL(source);
    if (figure.is("[data-nyt-datawrapper='true']") && parsed.hostname === "datawrapper.dwcdn.net") {
      urls.push(source);
      continue;
    }
    const documentMatch = /^\/newsgraphics\/documenttools\/[A-Za-z0-9_-]+\/(\d+)\/output-(\d+)\.png$/u.exec(parsed.pathname);
    if (
      figure.is("[data-nyt-derived-preview='true']")
      && parsed.hostname === "static01.nyt.com"
      && parsed.protocol === "https:"
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash
      && (
        documentMatch?.[1] === documentMatch?.[2]
        || (figure.is("[data-nyt-document-promo-full='true']") && /\.(?:avif|gif|jpe?g|png|webp)$/iu.test(parsed.pathname))
      )
    ) {
      urls.push(source);
      continue;
    }
    return false;
  }
  const uniqueUrls = [...new Set(urls)];
  if (!uniqueUrls.length) return true;
  const responses = await Promise.all(uniqueUrls.map((url) => fetchImpl(url, {
    method: "HEAD",
    headers: {
      accept: "image/*",
      "user-agent": BROWSER_USER_AGENT,
    },
    signal: AbortSignal.timeout(timeoutSeconds * 1_000),
  })));
  return responses.every((response) => response.ok && /^image\//iu.test(response.headers.get("content-type") ?? ""));
}

export async function captureNytGraphqlPage(
  url: string,
  timeoutSeconds: number,
  fetchImpl: typeof fetch = fetch,
): Promise<CapturedHtmlPage | undefined> {
  const capturedAt = new Date().toISOString();
  try {
    const canonical = new URL(url);
    if (canonical.hostname !== "www.nytimes.com") return undefined;
    const config = await graphqlConfig(fetchImpl, timeoutSeconds);
    const response = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: "https://www.nytimes.com",
        referer: canonical.toString(),
        "user-agent": BROWSER_USER_AGENT,
        ...config.headers,
      },
      body: JSON.stringify({
        operationName: "ArticleQuery",
        variables: { id: canonical.pathname },
        query: ARTICLE_QUERY,
      }),
      signal: AbortSignal.timeout(timeoutSeconds * 1_000),
    });
    if (!response.ok) return undefined;
    const html = nytGraphqlArticleHtml(await response.json() as NytGraphqlResponse, canonical.toString());
    if (!html) return undefined;
    if (!await validateDerivedPreviews(html, timeoutSeconds, fetchImpl)) {
      warnFallback(canonical.toString(), "derived publisher preview validation failed");
      return undefined;
    }
    return {
      method: "direct",
      requestedUrl: url,
      finalUrl: canonical.toString(),
      status: response.status,
      renderedHtml: html,
      capturedAt,
    };
  } catch {
    return undefined;
  }
}

export function resetNytGraphqlConfigCacheForTests(): void {
  configPromise = undefined;
}
