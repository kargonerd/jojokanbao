import type { Candidate } from "../../types.js";

export function processReuters(candidate: Candidate): Candidate {
  return { ...candidate, publisherCategories: [...new Set(candidate.publisherCategories)] };
}
