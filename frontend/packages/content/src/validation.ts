import type {
  JojoCatalog,
  JojoDatasetIndex,
  JojoFragment,
  JojoItemManifest,
} from "./types";

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

export const asJojoDatasetIndex = (value: unknown): JojoDatasetIndex =>
  format(value, "jojo-delivery-index/1");

export const asJojoItemManifest = (value: unknown): JojoItemManifest =>
  format(value, "jojo-item-manifest/1");

export const asJojoFragment = (value: unknown): JojoFragment =>
  format(value, "jojo-fragment/1");
