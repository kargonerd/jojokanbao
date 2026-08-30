import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { TimesForeignContentLanguage } from "./language";

interface TimesPreferencesState {
  foreignContentLanguage: TimesForeignContentLanguage;
  setForeignContentLanguage: (language: TimesForeignContentLanguage) => void;
}

export const useTimesPreferencesStore = create<TimesPreferencesState>()(
  persist(
    (set) => ({
      foreignContentLanguage: "zh-CN",
      setForeignContentLanguage: (foreignContentLanguage) => set({ foreignContentLanguage }),
    }),
    { name: "jojo-times-preferences" },
  ),
);
