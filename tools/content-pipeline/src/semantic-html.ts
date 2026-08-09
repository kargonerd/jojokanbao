import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import sanitizeHtml from "sanitize-html";
import type {
  JojoAnnotation,
  JojoCanonicalAsset,
  JojoCanonicalChapter,
} from "@jojo/content";
import type { DecodedWereadChapter, PipelineDiagnostic } from "./models";

const ALLOWED_TAGS = [
  "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "ol", "ul", "li", "strong", "em", "sup", "sub",
  "a", "br", "hr", "figure", "figcaption",
];

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function mediaTypeFromUrl(url: string): string {
  const pathname = new URL(url, "https://relative.invalid/").pathname.toLowerCase();
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".webp")) return "image/webp";
  if (pathname.endsWith(".gif")) return "image/gif";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  return "image/jpeg";
}

function plainText(value: string): string {
  return sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim();
}

function textBody(content: string): string {
  return content
    .split(/\r?\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${sanitizeHtml(paragraph, { allowedTags: [], allowedAttributes: {} })}</p>`)
    .join("");
}

export interface SemanticChapterResult {
  chapter: JojoCanonicalChapter;
  annotations: JojoAnnotation[];
  assets: JojoCanonicalAsset[];
  characterCount: number;
}

export function convertWereadChapter(
  source: DecodedWereadChapter,
  diagnostics: PipelineDiagnostic[],
): SemanticChapterResult {
  if (source.contentType === "text/plain") {
    const value = textBody(source.content);
    return {
      chapter: {
        id: source.id,
        order: source.order,
        title: source.title,
        body: { format: "html", profile: "jojo-semantic-html/1", value },
        assetRefs: [],
      },
      annotations: [],
      assets: [],
      characterCount: plainText(value).length,
    };
  }

  const $ = cheerio.load(source.content, { xmlMode: true });
  $("script,iframe,style,link,meta,head").remove();
  const annotations: JojoAnnotation[] = [];
  const assets = new Map<string, JojoCanonicalAsset>();

  $("[data-wr-footernote], img.qqreader-footnote").each((index, element) => {
    const current = $(element);
    const note = String(
      current.attr("data-wr-footernote")
      || current.attr("alt")
      || current.text()
      || "",
    ).replace(/\s+/g, " ").trim();
    if (!note) {
      current.remove();
      return;
    }
    const id = `annotation:${shortHash(`${source.id}:${index}:${note}`)}`;
    annotations.push({
      id,
      targetId: source.id,
      kind: "footnote",
      label: String(annotations.length + 1),
      body: { format: "text", value: note },
    });
    current.replaceWith(`<sup data-annotation-id="${id}"></sup>`);
  });

  $("img").each((_index, element) => {
    const current = $(element);
    const sourceUrl = current.attr("src")?.trim();
    if (!sourceUrl) {
      current.remove();
      return;
    }
    if (/^(?:\.\.\/)?Images\/note\.png$/i.test(sourceUrl)) {
      current.remove();
      return;
    }
    const id = `asset:image-${shortHash(sourceUrl)}`;
    const alt = current.attr("alt")?.trim() || null;
    const remote = /^https:\/\//i.test(sourceUrl);
    if (!remote) {
      diagnostics.push({
        level: "warning",
        code: "unresolved-relative-asset",
        message: `章节 ${source.title} 引用了未随 JSON 导出的资源 ${sourceUrl}`,
        source: sourceUrl,
      });
    } else if (!assets.has(id)) {
      assets.set(id, {
        id,
        type: "image",
        role: "content",
        mediaType: mediaTypeFromUrl(sourceUrl),
        path: "",
        sourceUrl,
        size: 0,
        sha256: "",
        alt,
        caption: alt,
      });
    }
    if (!remote) {
      current.replaceWith(alt ? `<p>${sanitizeHtml(alt, { allowedTags: [] })}</p>` : "");
      return;
    }
    const figure = $(`<figure data-asset-id="${id}"></figure>`);
    if (alt) figure.append(`<figcaption>${sanitizeHtml(alt, { allowedTags: [] })}</figcaption>`);
    const parent = current.parent();
    if (parent.is("p") && parent.children().length === 1 && !parent.text().trim()) parent.replaceWith(figure);
    else current.replaceWith(figure);
  });

  const bodyHtml = $("body").length ? $("body").html() ?? "" : $.root().html() ?? "";
  const value = sanitizeHtml(bodyHtml, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      "*": ["id"],
      a: ["href"],
      figure: ["data-asset-id"],
      sup: ["data-annotation-id"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
  }).trim();

  return {
    chapter: {
      id: source.id,
      order: source.order,
      title: source.title,
      body: { format: "html", profile: "jojo-semantic-html/1", value },
      assetRefs: [...assets.keys()],
    },
    annotations,
    assets: [...assets.values()],
    characterCount: plainText(value).length,
  };
}

export function htmlToText(value: string): string {
  return cheerio.load(value).text().replace(/\s+/g, " ").trim();
}
