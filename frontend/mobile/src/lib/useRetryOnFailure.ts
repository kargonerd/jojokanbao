import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useRef } from "react";
import { AppState } from "react-native";

/** Retry failed reads even when connectivity returns without an AppState event. */
export function useRetryOnFailure(failed: boolean, retry: () => void) {
  const retryRef = useRef(retry);
  retryRef.current = retry;
  useFocusEffect(useCallback(() => {
    if (!failed) return;
    const attempt = () => {
      if (AppState.currentState === "active") retryRef.current();
    };
    const timer = setInterval(attempt, 15_000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") retryRef.current();
    });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [failed]));
}
