import { createScrapbookRepository } from "@jojo/auth";
import { useAccountSessionStore } from "../account/session";
export async function scrapbookRepository(ownerId = useAccountSessionStore.getState().userId || "") {
  const { authClient } = await import("../account/auth");
  return createScrapbookRepository(authClient, ownerId);
}
