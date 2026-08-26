function field(value: Record<string, unknown>, name: string): string {
  const candidate = value[name];
  return typeof candidate === "string" ? candidate.trim() : "";
}

function citationHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Stable, short token copied by the model to bind a claim to one exact reader location. */
export function citationIdForLocation(value: Record<string, unknown>): string | undefined {
  const targetId = field(value, "targetId") || field(value, "chapterId");
  if (!targetId) return undefined;
  const location = [
    field(value, "datasetId"),
    field(value, "itemId"),
    targetId,
    field(value, "anchorId"),
  ].join("\0");
  return `J${citationHash(location)}`;
}

export function addCitationIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(addCitationIds);
  if (typeof value !== "object" || value === null) return value;

  const source = value as Record<string, unknown>;
  const enriched = Object.fromEntries(
    Object.entries(source).map(([key, entry]) => [key, addCitationIds(entry)]),
  );
  const citationId = citationIdForLocation(enriched);
  return citationId && !field(enriched, "citationId")
    ? { ...enriched, citationId }
    : enriched;
}
