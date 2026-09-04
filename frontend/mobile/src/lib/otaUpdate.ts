import * as Updates from "expo-updates";

export type OtaUpdateResult = "disabled" | "current" | "ready" | "error";

export async function fetchOtaUpdate(): Promise<OtaUpdateResult> {
  if (!Updates.isEnabled) return "disabled";
  try {
    const update = await Updates.checkForUpdateAsync();
    if (!update.isAvailable) return "current";
    await Updates.fetchUpdateAsync();
    return "ready";
  } catch {
    return "error";
  }
}

export async function applyOtaUpdate(): Promise<void> {
  await Updates.reloadAsync();
}
