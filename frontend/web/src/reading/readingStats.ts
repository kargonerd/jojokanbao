import { useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ReadingStatsState {
  seconds: Record<string, number>;
  addTime: (key: string, seconds: number) => void;
}

export const useReadingStatsStore = create<ReadingStatsState>()(persist((set) => ({
  seconds: {},
  addTime: (key, seconds) => set((state) => ({ seconds: { ...state.seconds, [key]: (state.seconds[key] ?? 0) + seconds } })),
}), { name: "jojo-reading-stats" }));

/** Count active reading on this device, with checkpoints and no background time. */
export function useBookReadingTime(key: string, enabled: boolean): number {
  const seconds = useReadingStatsStore((state) => state.seconds[key] ?? 0);
  useEffect(() => {
    if (!enabled) return;
    let previous = Date.now();
    let lastActivity = previous;
    let focused = document.hasFocus();
    let visible = !document.hidden;
    let pendingMilliseconds = 0;
    const accrue = () => {
      const now = Date.now();
      const elapsed = Math.max(0, Math.min(now, lastActivity + 120_000) - previous);
      if (visible && focused && elapsed > 0) pendingMilliseconds += Math.min(elapsed, 15_000);
      previous = now;
    };
    const checkpoint = () => {
      accrue();
      if (pendingMilliseconds <= 0) return;
      const elapsed = pendingMilliseconds / 1000;
      pendingMilliseconds = 0;
      useReadingStatsStore.getState().addTime(key, elapsed);
    };
    // Scroll can fire every frame; accumulate in memory and persist on the timer.
    const activity = () => { accrue(); lastActivity = Date.now(); };
    const focus = () => { checkpoint(); lastActivity = Date.now(); focused = true; };
    const blur = () => { checkpoint(); focused = false; };
    // Flush the foreground tail using the previous visibility before switching.
    const visibility = () => { checkpoint(); visible = !document.hidden; if (visible) lastActivity = Date.now(); };
    const timer = window.setInterval(checkpoint, 10_000);
    window.addEventListener("pointerdown", activity);
    window.addEventListener("keydown", activity);
    window.addEventListener("scroll", activity, true);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    window.addEventListener("pagehide", checkpoint);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      checkpoint(); window.clearInterval(timer);
      window.removeEventListener("pointerdown", activity);
      window.removeEventListener("keydown", activity);
      window.removeEventListener("scroll", activity, true);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
      window.removeEventListener("pagehide", checkpoint);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [enabled, key]);
  return seconds;
}
