import type { Candidate } from "../../types.js";

export function processNikkei(candidate: Candidate): Candidate {
  return { ...candidate, publisherCategories: [...new Set(candidate.publisherCategories)] };
}
