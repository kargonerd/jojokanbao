import { Pressable, StyleSheet, Text, View } from "react-native";
import { IS_EINK_RELEASE } from "../config/appVariant";
import { mobileTheme } from "../theme/tokens";

export function AuthenticatedFeatureGate({
  initialized,
  signedIn,
  description,
  onSignIn,
}: {
  initialized: boolean;
  signedIn: boolean;
  description: string;
  onSignIn(): void;
}) {
  const theme = mobileTheme;
  if (signedIn) return null;
  return (
    <View style={styles.root}>
      <View style={[styles.rule, { backgroundColor: theme.red }]} />
      <Text style={[styles.title, { color: theme.ink, fontFamily: theme.serif }]}>
        {initialized ? "登录后继续" : "正在读取账号…"}
      </Text>
      <Text style={[styles.description, { color: theme.muted, fontFamily: theme.sans }]}>{description}</Text>
      {initialized ? (
        <Pressable
          accessibilityRole="button"
          onPress={onSignIn}
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: theme.red, opacity: pressed && !IS_EINK_RELEASE ? 0.8 : 1 },
          ]}
        >
          <Text style={[styles.buttonText, { color: theme.inverse, fontFamily: theme.sans }]}>登录 / 注册</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, paddingBottom: 50 },
  rule: { width: 3, height: 36, marginBottom: 18 },
  title: { fontSize: 24, lineHeight: 32, fontWeight: "900" },
  description: { maxWidth: 360, marginTop: 9, fontSize: 12, lineHeight: 21, textAlign: "center" },
  button: { minWidth: 148, height: 44, marginTop: 22, alignItems: "center", justifyContent: "center", paddingHorizontal: 22 },
  buttonText: { fontSize: 12, fontWeight: "900" },
});
