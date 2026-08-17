function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s·—_《》〈〉，。！？、：；,.!?:;()（）【】\[\]-]/g, "");
}

export function fuzzyBookTitleScore(title: string, query: string): number {
  const normalizedTitle = normalize(title);
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return 0;

  const directIndex = normalizedTitle.indexOf(normalizedQuery);
  if (directIndex >= 0) return directIndex + (normalizedTitle.length - normalizedQuery.length) / 100;

  let titleIndex = 0;
  let gaps = 0;
  for (const character of normalizedQuery) {
    const foundAt = normalizedTitle.indexOf(character, titleIndex);
    if (foundAt < 0) return Number.POSITIVE_INFINITY;
    gaps += foundAt - titleIndex;
    titleIndex = foundAt + 1;
  }

  return 100 + gaps + (normalizedTitle.length - normalizedQuery.length) / 100;
}
