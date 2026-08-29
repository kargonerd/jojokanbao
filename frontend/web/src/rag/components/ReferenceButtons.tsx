import type { RagReference } from "../types";
import { withReaderReturnTo } from "../readerNavigation";

export interface AnswerCitation {
  number: number;
  reference: RagReference;
}

export function referenceHref(reference: RagReference, returnTo?: string): string | undefined {
  if (!reference.datasetId || !reference.itemId || !reference.targetId) {
    return undefined;
  }
  const query = new URLSearchParams({ chapter: reference.targetId });
  if (reference.anchorId) query.set("anchor", reference.anchorId);
  const quote = reference.excerpt
    ?.replace(/^…+|…+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  if (quote) query.set("quote", quote);
  const href = `/book/${encodeURIComponent(reference.datasetId)}/${encodeURIComponent(reference.itemId)}?${query}`;
  return returnTo ? withReaderReturnTo(href, returnTo) : href;
}

function exactReferenceKey(reference: RagReference): string {
  return [
    reference.datasetId || "",
    reference.itemId || "",
    reference.targetId || "",
    reference.anchorId || "",
  ].join("\0");
}

export function answerCitations(
  content: string,
  references: RagReference[] = [],
): AnswerCitation[] {
  const byCitationId = new Map(
    references.flatMap((reference) => reference.citationId
      ? [[reference.citationId, reference] as const]
      : []),
  );
  const cited: AnswerCitation[] = [];
  const seen = new Set<string>();
  let containsCitationTokens = false;
  for (const match of content.matchAll(/\[cite:([A-Za-z0-9_-]+)\]/g)) {
    containsCitationTokens = true;
    const citationId = match[1];
    if (!citationId) continue;
    const reference = byCitationId.get(citationId);
    if (!reference) continue;
    const key = exactReferenceKey(reference);
    if (seen.has(key)) continue;
    seen.add(key);
    cited.push({ number: cited.length + 1, reference });
  }
  if (containsCitationTokens) return cited;

  const numeric = [...content.matchAll(/\[(\d+)\]/g)]
    .map((match) => Number(match[1]))
    .filter((number) => number >= 1 && number <= references.length);
  if (numeric.length) {
    for (const number of numeric) {
      const reference = references[number - 1];
      if (!reference) continue;
      const key = exactReferenceKey(reference);
      if (seen.has(key)) continue;
      seen.add(key);
      cited.push({ number, reference });
    }
    return cited;
  }

  for (const reference of references) {
    const key = exactReferenceKey(reference);
    if (seen.has(key)) continue;
    seen.add(key);
    cited.push({ number: cited.length + 1, reference });
    if (cited.length >= 8) break;
  }
  return cited;
}

export function ReferenceButtons({
  content = "",
  references,
  returnTo,
}: {
  content?: string;
  references?: RagReference[];
  returnTo?: string;
}) {
  const citations = answerCitations(content, references)
    .filter(({ reference }) => reference.targetId);
  const grouped = new Map<string, {
    numbers: number[];
    reference: RagReference;
  }>();
  for (const citation of citations) {
    const reference = citation.reference;
    const key = [reference.datasetId || "", reference.itemId || "", reference.targetId || ""].join("\0");
    const existing = grouped.get(key);
    if (existing) {
      existing.numbers.push(citation.number);
    } else {
      grouped.set(key, { numbers: [citation.number], reference });
    }
  }
  const visible = [...grouped.values()].slice(0, 8);
  if (!visible.length) return null;

  return (
    <div aria-label="回答引用" className="mt-4 border-t border-rule pt-3">
      <p className="mb-2 mt-0 font-sans text-[10px] font-bold tracking-[.16em] text-muted">
        引用
      </p>
      <div className="flex flex-wrap gap-x-2 gap-y-2 font-sans text-xs">
        {visible.map(({ numbers, reference }) => {
          const chapter = reference.title || "原文位置";
          const book = reference.itemTitle || reference.datasetTitle;
          const label = book && !chapter.includes(book) ? `《${book}》 · ${chapter}` : chapter;
          const numberedLabel = `[${numbers.join(", ")}] ${label}`;
          const className = "border border-rule bg-transparent px-2.5 py-1.5 text-current no-underline cursor-pointer hover:border-red hover:text-red focus-visible:outline-2 focus-visible:outline-red";
          const href = referenceHref(reference, returnTo);
          return href ? (
            <a
              key={`${reference.itemId ?? ""}:${reference.targetId}`}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className={className}
            >
              {numberedLabel} ↗
            </a>
          ) : (
            <span
              key={`${reference.itemId ?? ""}:${reference.targetId}`}
              className="border border-rule px-2.5 py-1.5 text-muted"
              title="这条引用缺少书籍定位信息"
            >
              {numberedLabel}
            </span>
          );
        })}
      </div>
    </div>
  );
}
