import Ionicons from "@expo/vector-icons/Ionicons";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useMobileAuthStore } from "../account/auth";
import { IS_EINK_RELEASE } from "../config/appVariant";
import type { RootStackParamList } from "../navigation/types";
import { mobileTheme } from "../theme/tokens";

export function ScreenHeader({ eyebrow, title, onBack, showAccount = false }: { eyebrow?: string; title: string; onBack?: () => void; showAccount?: boolean }) {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const initialized = useMobileAuthStore((state) => state.initialized);
  const user = useMobileAuthStore((state) => state.user);
  const profile = useMobileAuthStore((state) => state.profile);
  const theme = mobileTheme;
  const accountLabel = !initialized ? "" : user ? profile?.display_name?.trim() || "账号" : "登录";

  return (
    <View style={[styles.header, { borderBottomColor: theme.ruleDark, backgroundColor: theme.paper }]}>
      {onBack ? (
        <Pressable accessibilityRole="button" accessibilityLabel="返回" hitSlop={8} onPress={onBack} style={styles.backButton}>
          <Ionicons name="arrow-back" size={18} color={theme.red} />
          <Text style={[styles.backLabel, { color: theme.red, fontFamily: theme.sans }]}>返回</Text>
        </Pressable>
      ) : (
        <Image
          source={IS_EINK_RELEASE
            ? require("../../assets/android-icon-monochrome.png")
            : require("../../assets/brand-mark.png")}
          style={[styles.mark, IS_EINK_RELEASE && styles.eInkMark, IS_EINK_RELEASE && { tintColor: theme.ink }]}
          accessibilityIgnoresInvertColors
        />
      )}
      <View style={styles.copy}>
        {eyebrow ? <Text style={[styles.eyebrow, { color: theme.red, fontFamily: theme.sans }]}>{eyebrow}</Text> : null}
        <Text style={[styles.title, !eyebrow && styles.titleOnly, { color: theme.ink, fontFamily: theme.serif }]}>{title}</Text>
      </View>
      {showAccount ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={user ? `${accountLabel}，进入账号与设置` : "登录，进入账号"}
          disabled={!initialized}
          hitSlop={8}
          onPress={() => navigation.navigate("Account")}
          style={styles.accountButton}
        >
          <Text numberOfLines={1} style={[styles.accountLabel, { color: theme.red, fontFamily: theme.sans }]}>{accountLabel}</Text>
        </Pressable>
      ) : <View style={styles.trailingSpacer} />}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    height: 58,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
  },
  copy: { flex: 1, minWidth: 0, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  backButton: { width: 72, height: 44, flexDirection: "row", alignItems: "center", gap: 5 },
  backLabel: { fontSize: 11, fontWeight: "800" },
  eyebrow: { fontSize: 8, fontWeight: "800", letterSpacing: 1.2 },
  title: { marginTop: 2, fontSize: 14, fontWeight: "900", letterSpacing: 1.1, textAlign: "center" },
  titleOnly: { marginTop: 0, fontSize: 15 },
  mark: { width: 32, height: 32, marginHorizontal: 20 },
  eInkMark: { width: 64, height: 64, marginHorizontal: 4 },
  accountButton: { width: 72, height: 44, alignItems: "flex-end", justifyContent: "center" },
  accountLabel: { maxWidth: 72, fontSize: 11, fontWeight: "800", letterSpacing: 0.2 },
  trailingSpacer: { width: 72 },
});
