import { StyleSheet, Text, View } from "react-native";
import { mobileTheme } from "../theme/tokens";

export function SectionTitle({ title, aside }: { title: string; aside?: string }) {
  const theme = mobileTheme;
  return (
    <View style={[styles.row, { borderBottomColor: theme.ruleDark }]}>
      <Text style={[styles.title, { color: theme.ink, fontFamily: theme.serif }]}>{title}</Text>
      {aside ? <Text style={[styles.aside, { color: theme.muted, fontFamily: theme.sans }]}>{aside}</Text> : null}
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
  title: { fontSize: 18, fontWeight: "800", letterSpacing: 0.6 },
  aside: { fontSize: 11, fontWeight: "600" },
});
