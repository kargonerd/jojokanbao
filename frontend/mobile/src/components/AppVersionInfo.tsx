import { nativeApplicationVersion, nativeBuildVersion } from "expo-application";
import * as Clipboard from "expo-clipboard";
import { updateId } from "expo-updates";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { mobileTheme } from "../theme/tokens";

export function AppVersionInfo() {
  const [copyNotice, setCopyNotice] = useState("");
  const version = updateId || [nativeApplicationVersion, nativeBuildVersion].filter(Boolean).join(".") || "未知";
  const label = `版本标识：${version}`;
  const theme = mobileTheme;

  async function copyVersion() {
    try {
      await Clipboard.setStringAsync(label);
      setCopyNotice("版本信息已复制。");
    } catch {
      setCopyNotice("复制失败，可长按上方版本标识复制。");
    }
  }

  return <View style={[styles.panel, { borderBottomColor: theme.rule }]}>
    <Text selectable style={[styles.detail, { color: theme.muted, fontFamily: theme.sans }]}>{label}</Text>
    <Pressable accessibilityRole="button" onPress={() => void copyVersion()} style={[styles.button, { borderColor: theme.rule }]}>
      <Text style={[styles.buttonText, { color: theme.ink, fontFamily: theme.sans }]}>复制版本信息</Text>
    </Pressable>
    {copyNotice ? <Text accessibilityLiveRegion="polite" style={[styles.detail, { color: theme.muted, fontFamily: theme.sans }]}>{copyNotice}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  panel: { paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth, gap: 12 },
  detail: { fontSize: 12, lineHeight: 19 },
  button: { minHeight: 44, alignSelf: "flex-start", borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 10, justifyContent: "center" },
  buttonText: { fontSize: 12, fontWeight: "700" },
});
