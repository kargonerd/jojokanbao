import { isLibraryBookVisible, type LibraryBookPolicy } from "@jojo/content";
import { useCallback } from "react";
import { useMobileAuthStore } from "../account/auth";
import { useMobileStore } from "../store/mobileStore";

export function useLibraryVisibility() {
  const userId = useMobileAuthStore((state) => state.user?.id);
  const enabled = useMobileStore((state) => state.librarySources);
  return useCallback((book: LibraryBookPolicy) => isLibraryBookVisible(book, Boolean(userId), enabled), [userId, enabled]);
}
