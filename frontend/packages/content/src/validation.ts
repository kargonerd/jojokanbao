import type {
  JojoCatalog,
  JojoBookSearchIndex,
  JojoDatasetIndex,
  JojoFragment,
  JojoItemManifest,
} from "./types.js";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("JOJO object must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function format<T>(value: unknown, expected: string): T {
  const object = record(value);
  if (object.formatVersion !== expected) {
    throw new Error(`Expected ${expected}, received ${String(object.formatVersion)}`);
  }
  return value as T;
}

export const asJojoCatalog = (value: unknown): JojoCatalog =>
  format(value, "jojo-catalog/1");

export const asJojoDatasetIndex = (
  value: unknown,
): JojoDatasetIndex & { items: NonNullable<JojoDatasetIndex["items"]> } => {
  const object = record(value);
  if (object.formatVersion === "jojo-delivery-index/1") {
    return {
      ...object,
      items: Array.isArray(object.items) ? object.items : [],
    } as unknown as JojoDatasetIndex & { items: NonNullable<JojoDatasetIndex["items"]> };
  }
  // Early v1 publishers used the canonical label on the delivery index even
  // though the object already contained revision + items. Accept only that
  // exact legacy shape; a real canonical dataset (itemPath, no items) remains
  // invalid here.
  if (object.formatVersion === "jojo-dataset/1"
    && typeof object.revision === "number"
    && typeof object.datasetId === "string"
    && typeof object.type === "string"
    && typeof object.title === "string"
    && typeof object.language === "string"
    && Array.isArray(object.items)) {
    return {
      ...object,
      formatVersion: "jojo-delivery-index/1",
    } as unknown as JojoDatasetIndex & { items: NonNullable<JojoDatasetIndex["items"]> };
  }
  throw new Error(`Expected jojo-delivery-index/1, received ${String(object.formatVersion)}`);
};

export const asJojoItemManifest = (value: unknown): JojoItemManifest =>
  format(value, "jojo-item-manifest/1");

export const asJojoBookSearchIndex = (value: unknown): JojoBookSearchIndex =>
  format(value, "jojo-book-search/1");

export const asJojoFragment = (value: unknown): JojoFragment =>
  format(value, "jojo-fragment/1");
