import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { BackHandler, Keyboard, PanResponder, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import type { MobileTheme } from "../theme/tokens";

export function ReaderNavigationSheet({ tab, onTabChange, onClose, bottom, top, theme, children }: {
  tab: "toc" | "search";
  onTabChange: (tab: "toc" | "search") => void;
  onClose: () => void;
  bottom: number;
  top: number;
  theme: MobileTheme;
  children: ReactNode;
}) {
  const { height } = useWindowDimensions();
  const [expanded, setExpanded] = useState(true);
  const [drag, setDrag] = useState(0);
  const dismiss = useCallback(() => { Keyboard.dismiss(); onClose(); }, [onClose]);
  useEffect(() => {
    const listener = BackHandler.addEventListener("hardwareBackPress", () => { dismiss(); return true; });
    return () => listener.remove();
  }, [dismiss]);
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dy) > 5,
    onPanResponderMove: (_, gesture) => setDrag(gesture.dy),
    onPanResponderRelease: (_, gesture) => {
      if (gesture.dy > 80) dismiss();
      else if (gesture.dy < -50) setExpanded(true);
      else if (Math.abs(gesture.dy) < 5) setExpanded((value) => !value);
      setDrag(0);
    },
    onPanResponderTerminate: () => setDrag(0),
  }), [dismiss]);
  const availableHeight = height - bottom - top;
  const sheetHeight = Math.max(120, Math.min(availableHeight, (expanded ? availableHeight : height * .66) - drag));

  return <>
    <Pressable accessibilityRole="button" accessibilityLabel="关闭书内导航" onPress={dismiss} style={[styles.backdrop, { bottom }]} />
    <View style={[styles.sheet, { bottom, height: sheetHeight, backgroundColor: theme.paper }]}>
      <View {...pan.panHandlers} accessible accessibilityRole="adjustable" accessibilityLabel="调整书内导航高度" accessibilityActions={[{ name: "increment", label: "展开" }, { name: "decrement", label: "关闭" }]} onAccessibilityAction={(event) => event.nativeEvent.actionName === "increment" ? setExpanded(true) : dismiss()} style={styles.handle}>
        <View style={[styles.grip, { backgroundColor: theme.muted }]} />
      </View>
      <View accessibilityRole="tablist" style={[styles.tabs, { backgroundColor: theme.paperSoft }]}>
        {(["search", "toc"] as const).map((value) => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: tab === value }} onPress={() => onTabChange(value)} style={[styles.tab, tab === value && { backgroundColor: theme.paper }]}>
          <Text style={{ fontSize: 14, fontWeight: tab === value ? "700" : "400", color: tab === value ? theme.red : theme.muted, fontFamily: theme.serif }}>{value === "search" ? "⌕ 搜本书" : "目录"}</Text>
        </Pressable>)}
      </View>
      {children}
    </View>
  </>;
}

const styles = StyleSheet.create({
  backdrop: { position: "absolute", top: 0, left: 0, right: 0, zIndex: 4 },
  sheet: { position: "absolute", left: 0, right: 0, zIndex: 5, overflow: "hidden" },
  handle: { height: 36, flexShrink: 0, alignItems: "center", justifyContent: "center" },
  grip: { width: 36, height: 3, opacity: .45 },
  tabs: { marginHorizontal: 20, marginBottom: 8, padding: 4, flexDirection: "row", gap: 4, flexShrink: 0 },
  tab: { flex: 1, minHeight: 42, alignItems: "center", justifyContent: "center", padding: 8 },
});
