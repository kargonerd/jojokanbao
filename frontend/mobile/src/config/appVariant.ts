import { applicationId } from "expo-application";
import { Platform } from "react-native";
import { resolveRuntimeAppVariant } from "./resolveAppVariant";

// Web previews do not have an Android application id, so use the explicit build
// variant there. Native releases keep the package id as the source of truth.
export const APP_VARIANT = resolveRuntimeAppVariant({
  platform: Platform.OS,
  applicationId,
  explicitVariant: process.env.EXPO_PUBLIC_APP_VARIANT,
});
export const IS_EINK_RELEASE = APP_VARIANT === "eink";
