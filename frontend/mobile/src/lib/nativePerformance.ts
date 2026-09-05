import { Platform } from "react-native";

export function shouldRemoveClippedSubviews(platform: string): boolean {
  return platform === "android";
}

// Native virtualization remains active on both platforms. View clipping is an
// Android-only optimization because it can hide valid list rows on iOS.
export const REMOVE_CLIPPED_SUBVIEWS = shouldRemoveClippedSubviews(Platform.OS);
