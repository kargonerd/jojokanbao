import { useCallback } from "react";
import { DEFAULT_LIBRARY_SOURCES, isLibraryBookVisible, normalizeLibrarySources, type LibraryBookPolicy, type LibrarySourceId } from "@jojo/content";
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface LibraryPreferences {
  enabledSources: LibrarySourceId[];
  setSourceEnabled: (source: LibrarySourceId, enabled: boolean) => void;
}

export const useLibraryPreferencesStore = create<LibraryPreferences>()(persist((set) => ({
  enabledSources: [...DEFAULT_LIBRARY_SOURCES],
  setSourceEnabled: (source, enabled) => set((state) => ({
    enabledSources: normalizeLibrarySources(enabled ? [...state.enabledSources, source] : state.enabledSources.filter((id) => id !== source)),
  })),
}), {
  name: "jojo-library-preferences",
  merge: (saved, current) => {
    const persisted = saved as Partial<LibraryPreferences> | undefined;
    return { ...current, ...persisted, enabledSources: normalizeLibrarySources(persisted?.enabledSources ?? current.enabledSources) };
  },
}));

export function useLibraryVisibility(signedIn: boolean) {
  const enabled = useLibraryPreferencesStore((state) => state.enabledSources);
  return useCallback((book: LibraryBookPolicy) => isLibraryBookVisible(book, signedIn, enabled), [signedIn, enabled]);
}

// Keep readers in other tabs in step with changes made in Settings.
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (!event.key || event.key === "jojo-library-preferences") void useLibraryPreferencesStore.persist.rehydrate();
});
