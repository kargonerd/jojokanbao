import { createContentCorrectionRepository } from "@jojo/auth";
import type { ContentCorrectionCategory, ContentCorrectionSource } from "@jojo/auth";

async function repository() {
  const { authClient } = await import("../account/auth");
  return createContentCorrectionRepository(authClient);
}
export async function submitContentCorrection(source: ContentCorrectionSource, category: ContentCorrectionCategory, details: string, requestId: string, expectedUserId: string) {
  return (await repository()).submit(source, category, details, requestId, expectedUserId);
}
export async function loadMyContentCorrections(source?: Pick<ContentCorrectionSource, "contentType" | "contentId">) {
  return (await repository()).list(source);
}
