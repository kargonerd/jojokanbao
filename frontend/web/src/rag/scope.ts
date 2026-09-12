import { ARCHIVE_PUBLICATION_BY_ID, JOJO_AI_PERIODICAL_IDS } from "@jojo/content";
import type { RagNotebook } from "./types";

export type RagContentType = "book" | "periodical";

export function scopeNotebooks(notebooks: RagNotebook[], contentType: RagContentType): RagNotebook[] {
  return contentType === "periodical"
    ? JOJO_AI_PERIODICAL_IDS.map((id) => ({
      id, title: ARCHIVE_PUBLICATION_BY_ID[id].title, type: "newspaper",
    }))
    : notebooks.filter((notebook) => !notebook.type || notebook.type === "book" || notebook.type === "book-series");
}
