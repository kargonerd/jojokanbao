import type { JojoCatalogEntry } from "./types";

/** Missing capability metadata is intentionally treated as disabled. */
export function supportsJojoDatasetAi(
  dataset: Pick<JojoCatalogEntry, "aiEnabled">,
): boolean {
  return dataset.aiEnabled === true;
}
