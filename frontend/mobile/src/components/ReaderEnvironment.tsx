import { useEffect } from "react";
import { useKeepAwake } from "expo-keep-awake";
import * as ScreenOrientation from "expo-screen-orientation";
import { useMobileStore } from "../store/mobileStore";

function KeepAwakeGuard() {
  useKeepAwake("jojo-reader");
  return null;
}

export function ReaderEnvironment() {
  const keepScreenAwake = useMobileStore((state) => state.keepScreenAwake);
  const allowLandscape = useMobileStore((state) => state.allowLandscape);

  useEffect(() => {
    if (allowLandscape) return;
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => undefined);
    return () => {
      void ScreenOrientation.unlockAsync().catch(() => undefined);
    };
  }, [allowLandscape]);

  return keepScreenAwake ? <KeepAwakeGuard /> : null;
}
