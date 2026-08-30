import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { TimesForeignContentLanguage } from "./language";

interface TimesPreferencesState {
  foreignContentLanguage: TimesForeignContentLanguage;
  disabledSourceIds: string[];
  setForeignContentLanguage: (language: TimesForeignContentLanguage) => void;
  setSourceEnabled: (sourceId: string, enabled: boolean, availableSourceIds: string[]) => boolean;
  setAllSourcesEnabled: (enabled: boolean, availableSourceIds: string[]) => void;
  enableAllSources: () => void;
}

export const useTimesPreferencesStore = create<TimesPreferencesState>()(
  persist(
    (set) => ({
      foreignContentLanguage: "zh-CN",
      disabledSourceIds: [],
      setForeignContentLanguage: (foreignContentLanguage) => set({ foreignContentLanguage }),
      setSourceEnabled: (sourceId, enabled, availableSourceIds) => {
        let changed = false;
        set((state) => {
          const disabled = new Set(state.disabledSourceIds);
          if (enabled) {
            changed = disabled.delete(sourceId);
          } else {
            const enabledCount = availableSourceIds.filter((id) => !disabled.has(id)).length;
            if (enabledCount <= 1 || disabled.has(sourceId)) return state;
            disabled.add(sourceId);
            changed = true;
          }
          return changed ? { disabledSourceIds: [...disabled] } : state;
        });
        return changed;
      },
      setAllSourcesEnabled: (enabled, availableSourceIds) => set({
        disabledSourceIds: enabled ? [] : availableSourceIds.slice(1),
      }),
      enableAllSources: () => set({ disabledSourceIds: [] }),
    }),
    { name: "jojo-times-preferences" },
  ),
);
