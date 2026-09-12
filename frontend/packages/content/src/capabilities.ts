import type { JojoCatalogEntry } from "./types";

/** Periodicals available to the AI through Reader's Elasticsearch service. */
export const JOJO_AI_PERIODICAL_IDS = ["rmrb"] as const;

/** Missing capability metadata is intentionally treated as disabled. */
export function supportsJojoDatasetAi(
  dataset: Pick<JojoCatalogEntry, "aiEnabled">,
): boolean {
  return dataset.aiEnabled === true;
}
