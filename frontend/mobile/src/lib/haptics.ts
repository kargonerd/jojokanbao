import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

async function fallbackImpact(style: Haptics.ImpactFeedbackStyle): Promise<void> {
  try {
    await Haptics.impactAsync(style);
  } catch {
    // Haptics are an enhancement; unsupported devices should stay usable.
  }
}

export async function selectionHaptic(enabled: boolean): Promise<void> {
  if (!enabled) return;
  if (Platform.OS === "android") {
    await fallbackImpact(Haptics.ImpactFeedbackStyle.Medium);
    return;
  }
  try {
    await Haptics.selectionAsync();
  } catch {
    // Haptics are an enhancement; unsupported devices should stay usable.
  }
}

export async function impactHaptic(enabled: boolean): Promise<void> {
  if (!enabled) return;
  await fallbackImpact(Platform.OS === "android"
    ? Haptics.ImpactFeedbackStyle.Heavy
    : Haptics.ImpactFeedbackStyle.Medium);
}

export async function toggleHaptic(enabled: boolean, _nextValue: boolean): Promise<void> {
  if (!enabled) return;
  if (Platform.OS === "android") {
    await fallbackImpact(Haptics.ImpactFeedbackStyle.Heavy);
    return;
  }
  try {
    await Haptics.selectionAsync();
  } catch {
    // See selectionHaptic.
  }
}
