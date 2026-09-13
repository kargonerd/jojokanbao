import { useIsFocused } from "@react-navigation/native";
import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import { useMobileAuthStore } from "../account/auth";
import { useMobileStore } from "../store/mobileStore";

const IDLE_MILLISECONDS = 120_000;

/** Count visible reading only, checkpointing without writing on each page turn. */
export function useBookReadingTime(datasetId: string, itemKey: string, enabled: boolean) {
  const focused = useIsFocused();
  const owner = useMobileAuthStore((state) => state.user?.id ?? "guest");
  const key = JSON.stringify([owner, datasetId, itemKey]);
  const seconds = useMobileStore((state) => state.bookReadingSeconds[key] ?? 0);
  const addSeconds = useMobileStore((state) => state.addBookReadingSeconds);
  const activity = useRef(Date.now());
  const checkpointActivity = useRef<() => void>(() => undefined);
  const recordActivity = useCallback(() => { checkpointActivity.current(); activity.current = Date.now(); }, []);

  useEffect(() => {
    if (!enabled || !focused) return;
    let active = AppState.currentState === "active";
    let checkpoint = Date.now();
    let pendingSeconds = 0;
    activity.current = checkpoint;
    function accrue() {
      const now = Date.now();
      const elapsed = active ? Math.max(0, Math.min(now, activity.current + IDLE_MILLISECONDS) - checkpoint) : 0;
      checkpoint = now;
      pendingSeconds += elapsed / 1000;
    }
    function flush() {
      accrue();
      if (pendingSeconds > 0) addSeconds(key, pendingSeconds);
      pendingSeconds = 0;
    }
    checkpointActivity.current = accrue;
    const timer = setInterval(flush, 15_000);
    const listener = AppState.addEventListener("change", (state) => {
      flush();
      active = state === "active";
      if (active) activity.current = Date.now();
    });
    return () => { clearInterval(timer); listener.remove(); flush(); checkpointActivity.current = () => undefined; };
  }, [addSeconds, enabled, focused, key]);

  return { seconds, recordActivity };
}
