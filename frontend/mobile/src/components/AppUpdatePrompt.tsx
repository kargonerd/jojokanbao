import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect } from "react";
import { Alert, Platform } from "react-native";
import { checkNativeAppUpdate, openNativeAppUpdate } from "../lib/appUpdate";

const dismissedUpdateKey = "@jojo/dismissed-native-update";

export function AppUpdatePrompt() {
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const timer = setTimeout(() => {
      void checkNativeAppUpdate().then(async (catalog) => {
        if (!catalog) return;
        const releaseKey = `${catalog.variant}:${catalog.buildNumber}`;
        if (!catalog.mandatory && await AsyncStorage.getItem(dismissedUpdateKey) === releaseKey) return;
        const download = { text: "下载更新", onPress: () => void openNativeAppUpdate(catalog) };
        Alert.alert(
          `发现 JOJO 看报 ${catalog.version}`,
          "安装包将从 JOJO 下载节点打开，并由 Android 系统确认安装。",
          catalog.mandatory
            ? [download]
            : [
                { text: "稍后", style: "cancel", onPress: () => void AsyncStorage.setItem(dismissedUpdateKey, releaseKey) },
                download,
              ],
          { cancelable: !catalog.mandatory },
        );
      });
    }, 4_000);
    return () => clearTimeout(timer);
  }, []);
  return null;
}
