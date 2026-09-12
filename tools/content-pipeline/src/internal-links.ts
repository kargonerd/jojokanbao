import * as cheerio from "cheerio";
import type { JojoAnnotation, JojoCanonicalChapter } from "@jojo/content";

export interface UnresolvedInternalLink {
  chapterId: string;
  reference: string;
  label: string;
}

// Run after chapter selection and volume splitting. A fragment without an
// explicit chapter target is local; a matching ID elsewhere is not evidence
// that the link belongs there.
export function downgradeUnresolvedInternalLinks(chapters: JojoCanonicalChapter[], annotations: JojoAnnotation[] = []): {
  chapters: JojoCanonicalChapter[];
  unresolved: UnresolvedInternalLink[];
} {
  const documents = new Map(chapters.filter((chapter) => chapter.body.format === "html")
    .map((chapter) => [chapter.id, cheerio.load(chapter.body.value)]));
  const anchors = new Map([...documents].map(([id, $]) => [
    id, new Set($("[id]").map((_index, element) => $(element).attr("id")!).get()),
  ]));
  const chapterIds = new Set(chapters.map((chapter) => chapter.id));
  for (const annotation of annotations) anchors.get(annotation.targetId)?.add(annotation.id);
  const unresolved: UnresolvedInternalLink[] = [];
  return {
    chapters: chapters.map((chapter) => {
      const $ = documents.get(chapter.id);
      if (!$) return chapter;
      let changed = false;
      $("a").each((_index, element) => {
        const current = $(element);
        const href = current.attr("href")?.trim();
        const target = current.attr("data-target-id") || chapter.id;
        let anchor = current.attr("data-anchor-id");
        if (!current.attr("data-target-id") && !anchor && !href?.startsWith("#")) return;
        let validEncoding = true;
        if (!anchor && href?.startsWith("#")) {
          try { anchor = decodeURIComponent(href.slice(1)); }
          catch { validEncoding = false; }
        }
        if (validEncoding && chapterIds.has(target) && (!anchor || anchors.get(target)?.has(anchor))) return;
        unresolved.push({
          chapterId: chapter.id,
          reference: `${target}${anchor ? `#${anchor}` : href ?? ""}`,
          label: current.text(),
        });
        // Preserve the printed marker, its formatting, and any return anchor.
        // Only the navigation behavior and link styling are removed.
        element.name = "span";
        current.removeAttr("href").removeAttr("data-target-id").removeAttr("data-anchor-id");
        changed = true;
      });
      return changed ? { ...chapter, body: { ...chapter.body, value: $("body").html() ?? "" } } : chapter;
    }),
    unresolved,
  };
}
