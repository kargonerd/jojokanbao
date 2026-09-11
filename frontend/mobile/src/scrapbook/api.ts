import { createScrapbookRepository, type ScrapbookRepository } from "@jojo/auth";
import { mobileAuthClient, useMobileAuthStore } from "../account/auth";
function repository() { return createScrapbookRepository(mobileAuthClient, useMobileAuthStore.getState().user?.id || ""); }
export const mobileScrapbook: ScrapbookRepository = {
  list: (...args) => repository().list(...args),
  collections: () => repository().collections(),
  save: (...args) => repository().save(...args),
  remove: (...args) => repository().remove(...args),
};
