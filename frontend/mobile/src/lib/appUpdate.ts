import { nativeBuildVersion } from "expo-application";
import { Linking, Platform } from "react-native";
import { IS_EINK_RELEASE } from "../config/appVariant";
import {
  isNativeUpdateAvailable,
  parseNativeReleaseCatalog,
  type NativeReleaseCatalog,
} from "./releaseCatalog";

const releaseBase = (process.env.EXPO_PUBLIC_RELEASE_CDN_BASE || "https://blacknews.jojokanbao.cn/releases").replace(/\/+$/, "");

export async function checkNativeAppUpdate(): Promise<NativeReleaseCatalog | undefined> {
  if (Platform.OS !== "android") return undefined;
  const product = IS_EINK_RELEASE ? "android-eink" : "android";
  const channel = "stable";
  try {
    const response = await fetch(`${releaseBase}/mobile/${product}/${channel}/catalog.json`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return undefined;
    const catalog = parseNativeReleaseCatalog(await response.json());
    if (!catalog || catalog.channel !== channel || catalog.variant !== (IS_EINK_RELEASE ? "eink" : "standard")) return undefined;
    if (catalog.artifacts.some((artifact) => !artifact.url.startsWith(`${releaseBase}/mobile/${product}/${channel}/`))) return undefined;
    return isNativeUpdateAvailable(nativeBuildVersion, catalog) ? catalog : undefined;
  } catch {
    return undefined;
  }
}

export async function openNativeAppUpdate(catalog: NativeReleaseCatalog): Promise<void> {
  const artifact = catalog.artifacts[0];
  if (artifact) await Linking.openURL(artifact.url);
}
