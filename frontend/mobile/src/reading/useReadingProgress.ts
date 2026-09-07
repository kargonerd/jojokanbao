import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useMemo } from "react";
import { AppState } from "react-native";

// Keep serialization and disk writes out of rapid page turns. A fixed window
// also checkpoints continuous scrolling, instead of waiting indefinitely for idle.
export function useReadingProgress<T>(save: (progress: T) => void) {
  const progress = useMemo(() => {
    let pending: { value: T } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function flush() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const latest = pending;
      pending = undefined;
      if (latest) save(latest.value);
    }
    function schedule(value: T) {
      pending = { value };
      timer ??= setTimeout(flush, 650);
    }
    return { schedule, flush };
  }, [save]);

  useFocusEffect(useCallback(() => progress.flush, [progress]));
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") progress.flush();
    });
    return () => { subscription.remove(); progress.flush(); };
  }, [progress]);

  return progress;
}
