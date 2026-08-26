import { marked } from "marked";
import DOMPurify from "dompurify";
import { answerCitations, referenceHref } from "../components/ReferenceButtons";
import type { RagReference } from "../types";

marked.setOptions({ async: false, breaks: true, gfm: true });

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html);
}

export function formatChatMarkdown(text: string, references: RagReference[] = []): string {
  const citations = answerCitations(text, references);
  const byCitationId = new Map(citations.flatMap(({ number, reference }) => (
    reference.citationId ? [[reference.citationId, number] as const] : []
  )));
  const normalized = text.replace(/\[cite:([A-Za-z0-9_-]+)\]/g, (_marker, citationId: string) => {
    const number = byCitationId.get(citationId);
    return number ? `[${number}]` : "";
  });
  const byNumber = new Map(citations.map((citation) => [citation.number, citation.reference]));
  let html = renderMarkdown(normalized);
  html = html.replace(/\[(\d+)\]/g, (marker, numberText: string) => {
    const number = Number(numberText);
    const reference = byNumber.get(number);
    if (!reference) return marker;
    const href = referenceHref(reference);
    const className = "jojo-citation inline-flex -translate-y-[.28em] items-center px-0.5 font-sans text-[10px] font-bold leading-none text-red no-underline hover:bg-red hover:text-white focus-visible:outline-2 focus-visible:outline-red";
    const label = `打开引用 ${number}`;
    return href
      ? `<a class="${className}" href="${href}" target="_blank" rel="noopener noreferrer" aria-label="${label}" data-citation="${number}"><sup>[${number}]</sup></a>`
      : `<sup class="${className}" data-citation="${number}">[${number}]</sup>`;
  });
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["data-citation", "target", "rel", "aria-label"],
  });
}
