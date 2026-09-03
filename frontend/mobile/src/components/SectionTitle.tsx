import { Pressable, StyleSheet, Text, View } from "react-native";
import { mobileTheme } from "../theme/tokens";

export function SectionTitle({ title, aside, onAsidePress }: { title: string; aside?: string; onAsidePress?: () => void }) {
  const theme = mobileTheme;
  return (
    <View style={[styles.row, { borderBottomColor: theme.ruleDark }]}>
      <Text style={[styles.title, { color: theme.ink, fontFamily: theme.serif }]}>{title}</Text>
      {aside ? onAsidePress ? (
        <Pressable accessibilityRole="button" onPress={onAsidePress} hitSlop={10}>
          <Text style={[styles.aside, { color: theme.red, fontFamily: theme.sans }]}>{aside}</Text>
        </Pressable>
      ) : <Text style={[styles.aside, { color: theme.muted, fontFamily: theme.sans }]}>{aside}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 42,
    borderBottomWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: { fontSize: 21, fontWeight: "500", letterSpacing: 0.2 },
  aside: { fontSize: 11, fontWeight: "800" },
});
