import { createHash } from "node:crypto";
import type { JojoCanonicalChapter } from "@jojo/content";
import { htmlToText } from "./semantic-html";

export interface JojoSearchDocument {
  formatVersion: "jojo-search-document/1";
  documentId: string;
  datasetId: string;
  datasetTitle: string;
  itemId: string;
  itemTitle: string;
  itemType: string;
  revision: number;
  targetId: string;
  targetType: "chapter";
  targetTitle: string;
  chunkId: string;
  order: number;
  text: string;
  authors: string[];
  publishedDate?: string;
  manifestObject: string;
  fragmentObject: string;
}

function chunks(value: string, size = 1_500, overlap = 150): string[] {
  if (value.length <= size) return value ? [value] : [];
  const output: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(value.length, start + size);
    if (end < value.length) {
      const breakAt = Math.max(
        value.lastIndexOf("。", end),
        value.lastIndexOf("！", end),
        value.lastIndexOf("？", end),
        value.lastIndexOf("\n", end),
      );
      if (breakAt > start + Math.floor(size * 0.55)) end = breakAt + 1;
    }
    output.push(value.slice(start, end).trim());
    if (end >= value.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return output.filter(Boolean);
}

export function chapterSearchDocuments(input: {
  datasetId: string;
  datasetTitle: string;
  itemId: string;
  itemTitle: string;
  itemType: string;
  authors: string[];
  publishedDate?: string;
  manifestObject: string;
  fragmentObjects: Map<string, string>;
  chapters: JojoCanonicalChapter[];
}): JojoSearchDocument[] {
  return input.chapters.flatMap((chapter) => {
    const text = htmlToText(chapter.body.value);
    return chunks(text).map((chunk, index) => {
      const chunkId = `chunk:${String(index + 1).padStart(4, "0")}`;
      const documentId = createHash("sha256")
        .update(`${input.itemId}\0${chapter.id}\0${chunkId}\0${chunk}`)
        .digest("hex");
      return {
        formatVersion: "jojo-search-document/1" as const,
        documentId,
        datasetId: input.datasetId,
        datasetTitle: input.datasetTitle,
        itemId: input.itemId,
        itemTitle: input.itemTitle,
        itemType: input.itemType,
        revision: 1,
        targetId: chapter.id,
        targetType: "chapter" as const,
        targetTitle: chapter.title,
        chunkId,
        order: index + 1,
        text: chunk,
        authors: input.authors,
        ...(input.publishedDate ? { publishedDate: input.publishedDate } : {}),
        manifestObject: input.manifestObject,
        fragmentObject: input.fragmentObjects.get(chapter.id)!,
      };
    });
  });
}
