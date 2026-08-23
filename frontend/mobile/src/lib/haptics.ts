import * as Haptics from "expo-haptics";

export async function selectionHaptic(enabled: boolean): Promise<void> {
  if (!enabled) return;
  try {
    await Haptics.selectionAsync();
  } catch {
    // Haptics are an enhancement; unsupported devices should stay usable.
  }
}

export async function impactHaptic(enabled: boolean): Promise<void> {
  if (!enabled) return;
  try {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  } catch {
    // See selectionHaptic.
  }
}
