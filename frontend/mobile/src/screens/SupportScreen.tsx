import { DONATION_RECORDS_URL } from "@jojo/content";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { useState } from "react";
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ScreenHeader } from "../components/ScreenHeader";
import type { RootStackParamList } from "../navigation/types";
import { mobileTheme } from "../theme/tokens";

const paymentCodes = [
  { label: "微信捐助", source: require("../../../packages/content/assets/support/weixin.png") },
  { label: "支付宝捐助", source: require("../../../packages/content/assets/support/zfb.png") },
];

export function SupportScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const [linkError, setLinkError] = useState(false);
  const theme = mobileTheme;

  async function openRecords() {
    setLinkError(false);
    try {
      await Linking.openURL(DONATION_RECORDS_URL);
    } catch {
      setLinkError(true);
    }
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.canvas }]}>
      <ScreenHeader title="支持我们" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.content} bounces={!theme.eInk} overScrollMode={theme.eInk ? "never" : "auto"}>
        <View style={[styles.panel, { backgroundColor: theme.paper, borderColor: theme.rule, borderTopColor: theme.red }]}>
          <Text accessibilityRole="header" style={[styles.title, { color: theme.red, fontFamily: theme.serif }]}>支持 JOJO 看报</Text>
          <Text style={[styles.body, { color: theme.ink, fontFamily: theme.serif }]}>
            如果 JOJO 看报对您有帮助，欢迎自愿捐助，支持网站与 APP 的持续维护。
          </Text>
          <View style={styles.codes}>
            {paymentCodes.map(({ label, source }) => (
              <View key={label} style={styles.code}>
                <Image
                  source={source}
                  accessibilityLabel={`${label}收款码`}
                  accessibilityIgnoresInvertColors
                  resizeMode="contain"
                  style={[styles.codeImage, { aspectRatio: Image.resolveAssetSource(source).width / Image.resolveAssetSource(source).height }]}
                />
              </View>
            ))}
          </View>
          <Text style={[styles.hint, { color: theme.muted, fontFamily: theme.sans }]}>所有捐助记录均在捐助列表中公示。</Text>
          <Pressable accessibilityRole="link" onPress={() => void openRecords()} style={[styles.records, { borderColor: theme.red }]}>
            <Text style={[styles.recordsText, { color: theme.red, fontFamily: theme.sans }]}>查看捐助公示</Text>
          </Pressable>
          {linkError ? <Text accessibilityRole="alert" style={[styles.hint, { color: theme.red, fontFamily: theme.sans }]}>无法打开捐助公示，请重试。</Text> : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: { width: "100%", maxWidth: 720, alignSelf: "center", padding: 20 },
  panel: { borderWidth: 1, borderTopWidth: 3, padding: 20 },
  title: { fontSize: 22, lineHeight: 32, fontWeight: "900" },
  body: { marginTop: 12, fontSize: 15, lineHeight: 26 },
  hint: { marginTop: 12, fontSize: 12, lineHeight: 21 },
  codes: { marginTop: 24, flexDirection: "row", flexWrap: "wrap", gap: 24 },
  code: { width: "100%", maxWidth: 240 },
  codeImage: { width: "100%" },
  records: { alignSelf: "flex-start", minHeight: 44, justifyContent: "center", marginTop: 12, paddingHorizontal: 16, borderWidth: 1 },
  recordsText: { fontSize: 13, fontWeight: "800" },
});
