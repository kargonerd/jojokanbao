import * as Brightness from "expo-brightness";
import { useCallback, useEffect, useRef, useState } from "react";

export function useReaderBrightness(onError: (message: string) => void) {
  const [brightness, setBrightness] = useState(0.65);
  const changed = useRef(false);
  const mounted = useRef(true);
  const writing = useRef(false);
  const pending = useRef<number | undefined>(undefined);
  const reportError = useRef(onError);
  reportError.current = onError;

  useEffect(() => {
    mounted.current = true;
    void Brightness.getBrightnessAsync().then((value) => {
      if (mounted.current && !changed.current) setBrightness(value);
    }).catch(() => undefined);
    return () => { mounted.current = false; pending.current = undefined; };
  }, []);

  const changeBrightness = useCallback((value: number) => {
    const next = Math.max(0.05, Math.min(1, value));
    changed.current = true;
    setBrightness(next);
    pending.current = next;
    if (writing.current) return;
    // Coalesce fast drag events without letting older native writes win.
    writing.current = true;
    void (async () => {
      try {
        while (mounted.current && pending.current !== undefined) {
          const target = pending.current;
          pending.current = undefined;
          try { await Brightness.setBrightnessAsync(target); }
          catch { if (mounted.current) reportError.current("亮度调整失败，请重试。"); }
        }
      } finally { writing.current = false; }
    })();
  }, []);

  return { brightness, changeBrightness };
}
