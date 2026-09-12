import { ARCHIVE_PUBLICATION_BY_ID, JOJO_AI_PERIODICAL_IDS } from "@jojo/content";
import type { RagNotebook } from "./types";

export type RagContentType = "all" | "book" | "periodical";

export const ALL_RAG_SOURCES_LABEL = "全部报刊 + 书籍";

export function scopeNotebooks(notebooks: RagNotebook[], contentType: RagContentType): RagNotebook[] {
  const periodicals = JOJO_AI_PERIODICAL_IDS.map((id) => ({
    id, title: ARCHIVE_PUBLICATION_BY_ID[id].title, type: "newspaper",
  }));
  const books = notebooks.filter((notebook) => !notebook.type || notebook.type === "book" || notebook.type === "book-series");
  return contentType === "all" ? [...periodicals, ...books] : contentType === "periodical" ? periodicals : books;
}
