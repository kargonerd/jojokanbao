import Ionicons from "@expo/vector-icons/Ionicons";
import { Pressable, StyleSheet, Text } from "react-native";
import { mobileTheme, type MobileTheme } from "../theme/tokens";
import { useMobileFeatureFlag } from "../reading/featureFlag";

export function BookshelfButton({ added, busy, disabled, label, onPress, theme = mobileTheme }: {
  added?: boolean;
  busy?: boolean;
  disabled?: boolean;
  label?: string;
  onPress: () => void;
  theme?: MobileTheme;
}) {
  const enabled = useMobileFeatureFlag("library.bookshelf");
  if (!enabled) return null;
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={label ?? (added ? "移出书架" : "加入书架")}
    accessibilityState={{ selected: Boolean(added), busy: Boolean(busy), disabled: Boolean(disabled || busy) }}
    disabled={disabled || busy}
    onPress={onPress}
    style={[styles.button, { opacity: disabled || busy ? 0.5 : 1 }]}
  >
    <Ionicons name={added ? "book" : "book-outline"} size={18} color={theme.red} />
    <Text style={[styles.label, { color: theme.red, fontFamily: theme.sans }]}>
      {busy ? "处理中…" : label ?? (added ? "已在书架" : "加入书架")}
    </Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  button: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", justifyContent: "center", minHeight: 44, paddingHorizontal: 8, gap: 5, flexShrink: 0 },
  label: { fontSize: 12, fontWeight: "700" },
});
