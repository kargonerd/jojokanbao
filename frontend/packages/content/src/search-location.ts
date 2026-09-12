/** Preserve the complete article title, including punctuation and long titles. */
export function searchResultTitle(value: string): string {
  return value.replace(/@\/?highlight@|<\/?mark>/gu, "").replace(/\s+/gu, " ").trim();
}

/** A short, contiguous excerpt: never concatenate separate search snippets. */
export function searchResultQuote(value: string, query: string): string {
  const firstSnippet = value.split(/\n\s*…\s*\n|\.\.\.|…/u).find((part) => (
    /@highlight@|<mark>/u.test(part) || part.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  )) ?? value.split(/\n\s*…\s*\n|\.\.\.|…/u)[0] ?? "";
  const text = firstSnippet.replace(/@\/?highlight@|<\/?mark>/gu, "").replace(/\s+/gu, " ").trim();
  if (!text) return query.trim().slice(0, 160);
  const hit = query ? text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1;
  const start = Math.max(0, hit - 28);
  return text.slice(start, start + 120).trim();
}

/** Append search context before an existing page hash. */
export function withSearchLocation(path: string, { query, title, quote, page, returnTo }: {
  query: string;
  title?: string;
  quote?: string;
  page?: number;
  returnTo?: string;
}): string {
  const [beforeHash = "", hash] = path.split("#", 2);
  const [pathname = "", existingQuery] = beforeHash.split("?", 2);
  const params = new URLSearchParams(existingQuery);
  if (query.trim()) params.set("query", query.trim().slice(0, 200));
  // An empty title is explicit: the reader must never substitute the query.
  if (title !== undefined) params.set("title", title.trim());
  if (quote?.trim()) params.set("quote", quote.trim().slice(0, 160));
  if (page && Number.isSafeInteger(page) && page > 0) params.set("searchPage", String(page));
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//") && !returnTo.includes("\\")) params.set("returnTo", returnTo);
  return `${pathname}${params.size ? `?${params}` : ""}${hash ? `#${hash}` : ""}`;
}
