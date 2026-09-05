import Ionicons from "@expo/vector-icons/Ionicons";
import { positionReaderSelection } from "@jojo/ui/reader-selection";
import { Pressable, StyleSheet, Text, View, type LayoutRectangle } from "react-native";
import type { BookReaderSelectionMessage } from "../lib/bookReaderBridge";
import type { MobileTheme } from "../theme/tokens";

const TOOLBAR_HEIGHT = 64;

export function ReaderSelectionToolbar({ selection, frame, theme, eInk, onCopy, onUnderline, onThought, onExplain }: {
  selection: BookReaderSelectionMessage;
  frame: LayoutRectangle;
  theme: MobileTheme;
  eInk: boolean;
  onCopy: () => void;
  onUnderline: () => void;
  onThought: () => void;
  onExplain: () => void;
}) {
  if (!selection.rect || !selection.viewport || !frame.width || !frame.height) return null;
  const scaleX = frame.width / selection.viewport.width;
  const scaleY = frame.height / selection.viewport.height;
  const rect = {
    left: frame.x + selection.rect.left * scaleX,
    right: frame.x + selection.rect.right * scaleX,
    top: frame.y + selection.rect.top * scaleY,
    bottom: frame.y + selection.rect.bottom * scaleY,
  };
  const position = positionReaderSelection(rect, { left: frame.x, top: frame.y, right: frame.x + frame.width, bottom: frame.y + frame.height }, { width: 288, height: TOOLBAR_HEIGHT });
  if (!position) return null;
  const backgroundColor = eInk ? "#202020" : "#333333";
  const actions = [
    { label: "复制", icon: "copy-outline", onPress: onCopy },
    { label: "划线", icon: null, onPress: onUnderline },
    { label: "写想法", icon: "create-outline", onPress: onThought },
    { label: "AI 解释", icon: "sparkles-outline", onPress: onExplain },
  ] as const;
  return <View style={[styles.container, { left: position.left, top: position.top, width: position.width }]}>
    <View style={[styles.actions, { backgroundColor }, !eInk && styles.shadow]}>
      {actions.map((action, index) => <Pressable key={action.label} accessibilityRole="button" accessibilityLabel={action.label} onPress={action.onPress} style={({ pressed }) => [styles.action, index === 3 && styles.aiAction, pressed && { backgroundColor: "#555555" }]}>
        {action.icon ? <Ionicons name={action.icon} size={22} color="#ffffff" /> : <Text aria-hidden style={styles.underline}>A</Text>}
        <Text style={[styles.label, { fontFamily: theme.sans }]}>{action.label}</Text>
      </Pressable>)}
    </View>
    <View pointerEvents="none" style={[styles.arrow, { left: position.arrowLeft - 7 }, position.above ? { top: TOOLBAR_HEIGHT, borderTopWidth: 7, borderTopColor: backgroundColor } : { bottom: TOOLBAR_HEIGHT, borderBottomWidth: 7, borderBottomColor: backgroundColor }]} />
  </View>;
}

const styles = StyleSheet.create({
  container: { position: "absolute", zIndex: 7 },
  actions: { height: TOOLBAR_HEIGHT, padding: 4, flexDirection: "row" },
  shadow: { shadowColor: "#000000", shadowOpacity: .18, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 8 },
  action: { flex: 1, alignItems: "center", justifyContent: "center", gap: 5 },
  aiAction: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: "#666666" },
  label: { color: "#ffffff", fontSize: 12, fontWeight: "600", lineHeight: 16 },
  underline: { height: 22, color: "#ffffff", fontSize: 22, lineHeight: 24, fontFamily: "serif", textDecorationLine: "underline" },
  arrow: { position: "absolute", width: 0, height: 0, borderLeftWidth: 7, borderRightWidth: 7, borderLeftColor: "transparent", borderRightColor: "transparent" },
});
