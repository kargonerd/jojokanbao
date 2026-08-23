import Ionicons from "@expo/vector-icons/Ionicons";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { IS_EINK_RELEASE } from "../config/appVariant";
import { mobileTheme } from "../theme/tokens";

export function ScreenHeader({ eyebrow, title, onBack }: { eyebrow?: string; title: string; onBack?: () => void }) {
  const theme = mobileTheme;

  return (
    <View style={[styles.header, { borderBottomColor: theme.ruleDark, backgroundColor: theme.paper }]}>
      {onBack ? (
        <Pressable accessibilityRole="button" accessibilityLabel="返回" hitSlop={8} onPress={onBack} style={styles.backButton}>
          <Ionicons name="chevron-back" size={24} color={theme.ink} />
        </Pressable>
      ) : null}
      <View style={styles.copy}>
        {eyebrow ? <Text style={[styles.eyebrow, { color: theme.red, fontFamily: theme.sans }]}>{eyebrow}</Text> : null}
        <Text style={[styles.title, !eyebrow && styles.titleOnly, { color: theme.ink, fontFamily: theme.serif }]}>{title}</Text>
      </View>
      <Image
        source={IS_EINK_RELEASE
          ? require("../../assets/android-icon-monochrome.png")
          : require("../../assets/brand-mark.png")}
        style={[styles.mark, IS_EINK_RELEASE && { tintColor: theme.ink }]}
        accessibilityIgnoresInvertColors
      />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    minHeight: 78,
    paddingHorizontal: 20,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
  },
  copy: { flex: 1 },
  backButton: { width: 38, height: 44, marginLeft: -7, marginRight: 3, alignItems: "flex-start", justifyContent: "center" },
  eyebrow: { fontSize: 10, fontWeight: "800", letterSpacing: 2.4 },
  title: { marginTop: 3, fontWeight: "800", letterSpacing: 0.5 },
  titleOnly: { marginTop: 0, fontSize: 24 },
  mark: { width: 44, height: 44 },
});
