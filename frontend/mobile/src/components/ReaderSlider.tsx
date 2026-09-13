import Slider from "@react-native-community/slider";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

/** Keep the native slider's gestures and accessibility with the reader's visual style. */
export function ReaderSlider({ label, value, minimumValue = 0, maximumValue = 1, color, trackColor, onValueChange, onSlidingStart, onSlidingComplete, style, disabled = false }: {
  label: string;
  value: number;
  minimumValue?: number;
  maximumValue?: number;
  color: string;
  trackColor: string;
  onValueChange?: (value: number) => void;
  onSlidingStart?: (value: number) => void;
  onSlidingComplete: (value: number) => void;
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
}) {
  const [displayValue, setDisplayValue] = useState(value);
  const dragging = useRef(false);
  useEffect(() => { if (!dragging.current) setDisplayValue(value); }, [value]);
  const percentage = Math.max(0, Math.min(100, (displayValue - minimumValue) / Math.max(Number.EPSILON, maximumValue - minimumValue) * 100));

  return <View style={[styles.control, style, disabled && { opacity: .4 }]}>
    <View pointerEvents="none" style={styles.railArea}>
      <View style={[styles.rail, { backgroundColor: trackColor }]} />
      <View style={[styles.fill, { backgroundColor: color, width: `${percentage}%` }]} />
      <View style={[styles.thumb, { backgroundColor: color, left: `${percentage}%` }]} />
    </View>
    <Slider accessibilityLabel={label} minimumValue={minimumValue} maximumValue={maximumValue} value={value} disabled={disabled}
      onSlidingStart={(next) => { dragging.current = true; setDisplayValue(next); onSlidingStart?.(next); }}
      onValueChange={(next) => { setDisplayValue(next); onValueChange?.(next); }}
      onSlidingComplete={(next) => { dragging.current = false; setDisplayValue(next); onSlidingComplete(next); }}
      minimumTrackTintColor="transparent" maximumTrackTintColor="transparent" thumbTintColor="transparent"
      style={styles.nativeControl} />
  </View>;
}

const styles = StyleSheet.create({
  control: { minHeight: 44, justifyContent: "center" },
  railArea: { height: 18, marginHorizontal: 16, justifyContent: "center" },
  rail: { height: 2, width: "100%" },
  fill: { position: "absolute", height: 2, left: 0, top: 8 },
  thumb: { position: "absolute", width: 8, height: 16, top: 1, marginLeft: -4 },
  nativeControl: { ...StyleSheet.absoluteFillObject, opacity: 0 },
});
