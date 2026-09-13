import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { mobileTheme as theme } from "../theme/tokens";

/** The same three vertical bars used by the web listening player. */
export function SpeechLoading({ color = theme.ink }: { color?: string }) {
  const bars = useRef([new Animated.Value(0.6), new Animated.Value(1), new Animated.Value(0.75)]).current;
  useEffect(() => {
    if (theme.eInk) return;
    const animation = Animated.loop(Animated.stagger(150, bars.map((value) => Animated.sequence([
      Animated.timing(value, { toValue: 1, duration: 600, useNativeDriver: true, isInteraction: false }),
      Animated.timing(value, { toValue: 0.6, duration: 600, useNativeDriver: true, isInteraction: false }),
    ]))));
    animation.start();
    return () => animation.stop();
  }, [bars]);
  return <View testID="speech-loading-bars" accessible={false} style={styles.bars}>
    {bars.map((value, index) => <Animated.View key={index} style={[styles.bar, {
      backgroundColor: color, transform: [{ scaleY: theme.eInk ? [0.5, 1, 0.7][index]! : value }],
    }]} />)}
  </View>;
}

const styles = StyleSheet.create({
  bars: { height: 28, width: 28, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4 },
  bar: { height: 14, width: 3 },
});
