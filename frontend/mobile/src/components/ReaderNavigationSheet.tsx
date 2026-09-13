import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Animated, BackHandler, Keyboard, PanResponder, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import type { MobileTheme } from "../theme/tokens";

export function ReaderNavigationSheet({ tab, onTabChange, onClose, bottom, top, theme, children, compact = false, contentHeight }: {
  tab?: "toc" | "search";
  onTabChange?: (tab: "toc" | "search") => void;
  onClose: () => void;
  bottom: number;
  top: number;
  theme: MobileTheme;
  children: ReactNode;
  compact?: boolean;
  /** Measured scroll content, excluding the drag handle. */
  contentHeight?: number;
}) {
  const { height } = useWindowDimensions();
  const [expanded, setExpanded] = useState(!compact);
  const [reduceMotion, setReduceMotion] = useState(false);
  const availableHeight = Math.max(0, height - bottom - top);
  const collapsedHeight = Math.min(availableHeight, Math.max(120, contentHeight === undefined ? Math.min(390, height * .6) : contentHeight + 36));
  const restingHeight = expanded ? availableHeight : collapsedHeight;
  const restingOffset = availableHeight - restingHeight;
  const translation = useRef(new Animated.Value(restingOffset)).current;
  const currentOffset = useRef(restingOffset);
  const dragOrigin = useRef(restingOffset);
  const lastMoveAt = useRef(0);
  const closing = useRef(false);
  const latest = useRef({ onClose, expanded, availableHeight, collapsedHeight, restingHeight, restingOffset, reduced: theme.eInk || reduceMotion });
  latest.current = { onClose, expanded, availableHeight, collapsedHeight, restingHeight, restingOffset, reduced: theme.eInk || reduceMotion };

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (active) setReduceMotion(value); }).catch(() => undefined);
    const listener = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => { active = false; listener.remove(); };
  }, []);
  const settle = useCallback((offset: number, complete?: () => void) => {
    translation.stopAnimation();
    if (latest.current.reduced) {
      currentOffset.current = offset;
      translation.setValue(offset);
      complete?.();
      return;
    }
    const animation = complete
      ? Animated.timing(translation, { toValue: offset, duration: 160, useNativeDriver: true })
      : Animated.spring(translation, { toValue: offset, stiffness: 320, damping: 34, mass: 1, overshootClamping: true, useNativeDriver: true });
    animation.start(({ finished }) => {
      if (finished) { currentOffset.current = offset; complete?.(); }
    });
  }, [translation]);
  const dismiss = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    Keyboard.dismiss();
    settle(latest.current.availableHeight + 24, () => latest.current.onClose());
  }, [settle]);
  const snap = useCallback((nextExpanded: boolean) => {
    setExpanded(nextExpanded);
    settle(nextExpanded ? 0 : latest.current.availableHeight - latest.current.collapsedHeight);
  }, [settle]);
  // Rotation or a changed compact content measurement changes the resting point,
  // never the layout on each pointer move. The native driver owns release motion.
  useLayoutEffect(() => {
    closing.current = false;
    translation.stopAnimation();
    currentOffset.current = latest.current.restingOffset;
    translation.setValue(currentOffset.current);
  }, [height, bottom, top, contentHeight, translation]);
  useEffect(() => () => { translation.stopAnimation(); }, [translation]);
  useEffect(() => {
    const listener = BackHandler.addEventListener("hardwareBackPress", () => { dismiss(); return true; });
    return () => listener.remove();
  }, [dismiss]);
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, gesture) => gesture.numberActiveTouches === 1 && Math.abs(gesture.dy) > 5 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
    onPanResponderGrant: () => {
      closing.current = false;
      lastMoveAt.current = Date.now();
      dragOrigin.current = currentOffset.current;
      translation.stopAnimation((value) => { dragOrigin.current = value; currentOffset.current = value; });
    },
    onPanResponderMove: (_, gesture) => {
      if (gesture.numberActiveTouches > 1) return;
      lastMoveAt.current = Date.now();
      currentOffset.current = Math.max(0, Math.min(latest.current.availableHeight + 24, dragOrigin.current + gesture.dy));
      translation.setValue(currentOffset.current);
    },
    onPanResponderRelease: (_, gesture) => {
      const threshold = Math.min(120, Math.max(72, latest.current.restingHeight * .18));
      const velocity = lastMoveAt.current && Date.now() - lastMoveAt.current >= 100 ? 0 : gesture.vy;
      if (gesture.dy > threshold || (gesture.dy > 12 && velocity > .65)) dismiss();
      else if (gesture.dy < -48 || (gesture.dy < -12 && velocity < -.65)) snap(true);
      else if (Math.abs(gesture.dy) < 5 && Math.abs(gesture.dx) < 5) snap(!latest.current.expanded);
      else settle(latest.current.restingOffset);
    },
    onPanResponderTerminate: () => settle(latest.current.restingOffset),
    onPanResponderTerminationRequest: () => true,
  }), [dismiss, settle, snap, translation]);
  const backdropOpacity = theme.eInk ? .06 : translation.interpolate({
    inputRange: [restingOffset, availableHeight + 24], outputRange: [.2, 0], extrapolate: "clamp",
  });

  return <>
    <Animated.View style={[styles.backdrop, { bottom, opacity: backdropOpacity }]}>
      <Pressable accessibilityRole="button" accessibilityLabel="关闭阅读工具" onPress={dismiss} style={styles.backdropTarget} />
    </Animated.View>
    <View pointerEvents="box-none" style={[styles.viewport, { bottom }]}>
      <Animated.View testID="reader-sheet-surface" style={[styles.sheet, {
        height: availableHeight, backgroundColor: theme.paper, borderTopColor: theme.rule,
        shadowOpacity: theme.eInk ? 0 : .24, elevation: theme.eInk ? 0 : 12,
        transform: [{ translateY: translation }],
      }]}>
        <View testID="reader-sheet-content" style={[styles.content, { height: restingHeight }]}>
          <View {...pan.panHandlers} accessible accessibilityRole="adjustable" accessibilityLabel="调整阅读工具高度" accessibilityActions={[{ name: "increment", label: "展开" }, { name: "decrement", label: "关闭" }]} onAccessibilityAction={(event) => event.nativeEvent.actionName === "increment" ? snap(true) : dismiss()} style={styles.handle}>
            <View style={[styles.grip, { backgroundColor: theme.muted }]} />
          </View>
          {tab ? <View accessibilityRole="tablist" style={[styles.tabs, { backgroundColor: theme.paperSoft }]}>
            {(["search", "toc"] as const).map((value) => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: tab === value }} onPress={() => { Keyboard.dismiss(); onTabChange?.(value); }} style={[styles.tab, tab === value && { backgroundColor: theme.paper }]}>
              <Text style={{ fontSize: 14, fontWeight: tab === value ? "700" : "400", color: tab === value ? theme.red : theme.muted, fontFamily: theme.serif }}>{value === "search" ? "⌕ 搜本书" : "目录"}</Text>
            </Pressable>)}
          </View> : null}
          {children}
        </View>
      </Animated.View>
    </View>
  </>;
}

const styles = StyleSheet.create({
  backdrop: { position: "absolute", top: 0, left: 0, right: 0, zIndex: 4 },
  backdropTarget: { flex: 1, backgroundColor: "#000000" },
  // Clip below the toolbar, with room above the surface for its shadow.
  viewport: { position: "absolute", top: 0, left: 0, right: 0, zIndex: 5, overflow: "hidden" },
  sheet: { position: "absolute", bottom: 0, left: 0, right: 0, borderTopWidth: StyleSheet.hairlineWidth, shadowColor: "#000000", shadowOffset: { width: 0, height: -4 }, shadowRadius: 14 },
  content: { overflow: "hidden" },
  handle: { height: 36, flexShrink: 0, alignItems: "center", justifyContent: "center" },
  grip: { width: 36, height: 3, opacity: .55 },
  tabs: { marginHorizontal: 20, marginBottom: 8, padding: 4, flexDirection: "row", gap: 4, flexShrink: 0 },
  tab: { flex: 1, minHeight: 42, alignItems: "center", justifyContent: "center", padding: 8 },
});
