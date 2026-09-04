import Ionicons from "@expo/vector-icons/Ionicons";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { useMemo, useState } from "react";
import {
  FlatList,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ScreenHeader } from "../components/ScreenHeader";
import { REMOVE_CLIPPED_SUBVIEWS } from "../lib/nativePerformance";
import { IS_EINK_RELEASE } from "../config/appVariant";
import type { RootStackParamList } from "../navigation/types";
import { mobileTheme } from "../theme/tokens";

interface PackageNotice {
  id: string;
  name: string;
  version: string;
  license: string;
  author: string;
  homepage: string;
  noticeIds: string[];
}

interface LicenseData {
  projectLicense: string;
  packages: PackageNotice[];
  notices: Record<string, { fileName: string; text: string }>;
}

const sourceUrl = "https://github.com/kargonerd/jojokanbao";
let cachedLicenseData: LicenseData | null = null;

function loadLicenseData(): LicenseData {
  if (!cachedLicenseData) {
    cachedLicenseData = require("../legal/open-source-notices.generated.json") as LicenseData;
  }
  return cachedLicenseData;
}

function packageNoticeText(item: PackageNotice, data: LicenseData): string {
  const texts = item.noticeIds
    .map((id) => data.notices[id])
    .filter((notice): notice is { fileName: string; text: string } => Boolean(notice))
    .map((notice) => `${notice.fileName}\n${"—".repeat(Math.min(notice.fileName.length, 20))}\n${notice.text}`);
  return texts.length
    ? texts.join("\n\n")
    : "该软件包未在发布目录中附带单独的许可文本，请通过上游项目地址查看完整声明。";
}

export function OpenSourceLicensesScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const theme = mobileTheme;
  const data = useMemo(loadLicenseData, []);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visiblePackages = useMemo(() => data.packages.filter((item) =>
    !normalizedQuery
    || item.name.toLocaleLowerCase().includes(normalizedQuery)
    || item.license.toLocaleLowerCase().includes(normalizedQuery)), [data.packages, normalizedQuery]);
  const selectedPackage = selectedId === "jojo-kanbao"
    ? null
    : data.packages.find((item) => item.id === selectedId) ?? null;

  if (selectedId) {
    const title = selectedPackage?.name ?? "JOJO 看报";
    const license = selectedPackage?.license ?? "AGPL-3.0-only";
    const notice = selectedPackage
      ? packageNoticeText(selectedPackage, data)
      : data.projectLicense;
    const upstream = selectedPackage?.homepage || sourceUrl;

    return (
      <SafeAreaView edges={["top"]} style={[styles.safe, { backgroundColor: theme.paper }]}>
        <ScreenHeader title="许可详情" onBack={() => setSelectedId(null)} />
        <ScrollView
          contentContainerStyle={styles.detailContent}
          showsVerticalScrollIndicator={false}
          overScrollMode={IS_EINK_RELEASE ? "never" : "always"}
        >
          <View style={[styles.detailHeader, { borderBottomColor: theme.red }]}>
            <Text style={[styles.detailTitle, { color: theme.ink, fontFamily: theme.serif }]}>{title}</Text>
            <Text style={[styles.detailLicense, { color: theme.red, fontFamily: theme.sans }]}>{selectedPackage?.version ? `${selectedPackage.version} · ` : ""}{license}</Text>
            {selectedPackage?.author ? <Text style={[styles.detailAuthor, { color: theme.muted, fontFamily: theme.sans }]}>{selectedPackage.author}</Text> : null}
            <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(upstream)} style={styles.upstreamButton}>
              <Text style={[styles.upstreamText, { color: theme.red, fontFamily: theme.sans }]}>{selectedPackage ? "查看上游项目" : "GitHub 查看源码"}</Text>
              <Ionicons name="open-outline" size={16} color={theme.red} />
            </Pressable>
          </View>
          <Text selectable style={[styles.licenseText, { color: theme.ink, fontFamily: theme.sans }]}>{notice}</Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={["top"]} style={[styles.safe, { backgroundColor: theme.paper }]}>
      <ScreenHeader title="开源软件许可" onBack={() => navigation.goBack()} />
      <FlatList
        data={visiblePackages}
        keyExtractor={(item) => item.id}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        removeClippedSubviews={REMOVE_CLIPPED_SUBVIEWS}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={7}
        getItemLayout={(_, index) => ({ length: 68, offset: 68 * index, index })}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={(
          <View>
            <View style={[styles.projectPanel, { borderColor: theme.rule, borderLeftColor: theme.red, backgroundColor: theme.paper }]}>
              <Text style={[styles.projectTitle, { color: theme.ink, fontFamily: theme.serif }]}>JOJO 看报</Text>
              <Text style={[styles.projectCopy, { color: theme.muted, fontFamily: theme.sans }]}>源代码以 GNU AGPL v3.0 only 发布，不提供任何明示或默示担保。</Text>
              <View style={styles.projectActions}>
                <Pressable accessibilityRole="button" onPress={() => setSelectedId("jojo-kanbao")} style={styles.projectAction}>
                  <Text style={[styles.projectActionText, { color: theme.red, fontFamily: theme.sans }]}>查看许可正文</Text>
                </Pressable>
                <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(sourceUrl)} style={styles.projectAction}>
                  <Text style={[styles.projectActionText, { color: theme.red, fontFamily: theme.sans }]}>查看源码</Text>
                  <Ionicons name="open-outline" size={15} color={theme.red} />
                </Pressable>
              </View>
            </View>
            <View style={styles.listHeading}>
              <View>
                <Text style={[styles.listTitle, { color: theme.ink, fontFamily: theme.serif }]}>第三方软件</Text>
                <Text style={[styles.listCount, { color: theme.muted, fontFamily: theme.sans }]}>{data.packages.length} 项发布依赖</Text>
              </View>
              <TextInput
                accessibilityLabel="搜索软件或许可证"
                value={query}
                onChangeText={setQuery}
                placeholder="搜索"
                placeholderTextColor={theme.muted}
                autoCapitalize="none"
                autoCorrect={false}
                clearButtonMode="while-editing"
                style={[styles.search, { color: theme.ink, borderColor: theme.ruleDark, fontFamily: theme.sans }]}
              />
            </View>
          </View>
        )}
        ListEmptyComponent={<Text style={[styles.empty, { color: theme.muted, fontFamily: theme.sans }]}>没有匹配的软件。</Text>}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.name} ${item.version}，${item.license}`}
            onPress={() => setSelectedId(item.id)}
            style={({ pressed }) => [
              styles.packageRow,
              { borderBottomColor: theme.rule, backgroundColor: pressed && !IS_EINK_RELEASE ? theme.paperSoft : theme.paper },
            ]}
          >
            <View style={styles.packageCopy}>
              <Text numberOfLines={1} style={[styles.packageName, { color: theme.ink, fontFamily: theme.sans }]}>{item.name}</Text>
              <Text numberOfLines={1} style={[styles.packageMeta, { color: theme.muted, fontFamily: theme.sans }]}>{item.version} · {item.license}</Text>
            </View>
            <Ionicons name="chevron-forward" size={17} color={theme.muted} />
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  listContent: { width: "100%", maxWidth: 760, alignSelf: "center", padding: 18, paddingBottom: 42 },
  projectPanel: { borderWidth: StyleSheet.hairlineWidth, borderLeftWidth: 4, padding: 16 },
  projectTitle: { fontSize: 18, fontWeight: "900", letterSpacing: 0.6 },
  projectCopy: { marginTop: 8, fontSize: 11, lineHeight: 19, fontWeight: "700" },
  projectActions: { marginTop: 12, flexDirection: "row", flexWrap: "wrap", gap: 18 },
  projectAction: { minHeight: 36, flexDirection: "row", alignItems: "center", gap: 5 },
  projectActionText: { fontSize: 11, fontWeight: "900", textDecorationLine: "underline" },
  listHeading: { minHeight: 84, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 14 },
  listTitle: { fontSize: 16, fontWeight: "900" },
  listCount: { marginTop: 4, fontSize: 9, fontWeight: "800" },
  search: { width: 142, height: 40, borderWidth: 1, paddingHorizontal: 11, fontSize: 12 },
  packageRow: { height: 68, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center", paddingHorizontal: 4 },
  packageCopy: { flex: 1, minWidth: 0, paddingRight: 12 },
  packageName: { fontSize: 12, fontWeight: "900" },
  packageMeta: { marginTop: 5, fontSize: 9, fontWeight: "700" },
  empty: { paddingVertical: 34, textAlign: "center", fontSize: 12, fontWeight: "800" },
  detailContent: { width: "100%", maxWidth: 760, alignSelf: "center", padding: 18, paddingBottom: 48 },
  detailHeader: { borderBottomWidth: 2, paddingBottom: 15 },
  detailTitle: { fontSize: 21, fontWeight: "900" },
  detailLicense: { marginTop: 7, fontSize: 10, fontWeight: "900" },
  detailAuthor: { marginTop: 7, fontSize: 10, lineHeight: 16, fontWeight: "700" },
  upstreamButton: { alignSelf: "flex-start", minHeight: 40, marginTop: 8, flexDirection: "row", alignItems: "center", gap: 5 },
  upstreamText: { fontSize: 11, fontWeight: "900", textDecorationLine: "underline" },
  licenseText: { marginTop: 18, fontSize: 10, lineHeight: 17 },
});
