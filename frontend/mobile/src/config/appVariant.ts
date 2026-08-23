import { applicationId } from "expo-application";
import { resolveAppVariant } from "./resolveAppVariant";

const buildValue = applicationId
  ? applicationId.endsWith(".eink") ? "eink" : "standard"
  : process.env.EXPO_PUBLIC_APP_VARIANT;

export const APP_VARIANT = resolveAppVariant(buildValue);
export const IS_EINK_RELEASE = APP_VARIANT === "eink";
