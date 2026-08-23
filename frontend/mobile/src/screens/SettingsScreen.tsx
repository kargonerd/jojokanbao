import Ionicons from "@expo/vector-icons/Ionicons";
import { ARCHIVE_WEB_ORIGIN } from "@jojo/content";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { nativeApplicationVersion } from "expo-application";
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ScreenHeader } from "../components/ScreenHeader";
import { SectionTitle } from "../components/SectionTitle";
import { IS_EINK_RELEASE } from "../config/appVariant";
import { selectionHaptic } from "../lib/haptics";
import type { RootStackParamList, SettingsSection } from "../navigation/types";
import { useMobileStore } from "../store/mobileStore";
import { mobileTheme } from "../theme/tokens";

function SettingRow({
  title,
  value,
  onValueChange,
}: {
  title: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}) {
  const theme = mobileTheme;
  return (
    <View style={[styles.settingRow, { borderBottomColor: theme.rule }]}>
      <View style={styles.settingCopy}>
        <Text style={[styles.settingTitle, { color: theme.ink, fontFamily: theme.serif }]}>{title}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: theme.rule, true: theme.red }}
        thumbColor={theme.paper}
        ios_backgroundColor={theme.rule}
      />
    </View>
  );
}

export function SettingsScreen() {
  const navigation = useNavigation();
  const route = useRoute<RouteProp<RootStackParamList, "Settings">>();
  const section = route.params?.section;
  const hapticsEnabled = useMobileStore((state) => state.hapticsEnabled);
  const setHapticsEnabled = useMobileStore((state) => state.setHapticsEnabled);
  const textScale = useMobileStore((state) => state.textScale);
  const setTextScale = useMobileStore((state) => state.setTextScale);
  const bookLineHeight = useMobileStore((state) => state.bookLineHeight);
  const setBookLineHeight = useMobileStore((state) => state.setBookLineHeight);
  const bookReadingMode = useMobileStore((state) => state.bookReadingMode);
  const setBookReadingMode = useMobileStore((state) => state.setBookReadingMode);
  const bookFirstLineIndent = useMobileStore((state) => state.bookFirstLineIndent);
  const setBookFirstLineIndent = useMobileStore((state) => state.setBookFirstLineIndent);
  const keepScreenAwake = useMobileStore((state) => state.keepScreenAwake);
  const setKeepScreenAwake = useMobileStore((state) => state.setKeepScreenAwake);
  const allowLandscape = useMobileStore((state) => state.allowLandscape);
  const setAllowLandscape = useMobileStore((state) => state.setAllowLandscape);
  const leftTapNext = useMobileStore((state) => state.leftTapNext);
  const setLeftTapNext = useMobileStore((state) => state.setLeftTapNext);
  const recentIssues = useMobileStore((state) => state.recentIssues);
  const recentBooks = useMobileStore((state) => state.recentBooks);
  const clearRecentReading = useMobileStore((state) => state.clearRecentReading);
  const theme = mobileTheme;
  const titles: Record<SettingsSection, string> = {
    reading: "阅读设置",
    interaction: "交互设置",
    data: "阅读数据",
    about: "关于",
  };

  return (
    <SafeAreaView edges={["top"]} style={[styles.safe, { backgroundColor: theme.paper }]}>
      <ScreenHeader title={section ? titles[section] : "设置"} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} overScrollMode={IS_EINK_RELEASE ? "never" : "always"}>
        {!section || section === "reading" ? (
          <>
            <SectionTitle title="阅读设置" />
            <View style={[styles.panel, { backgroundColor: theme.paper, borderColor: theme.rule }]}>
          <SettingRow
            title="阅读时不自动锁屏"
            value={keepScreenAwake}
            onValueChange={setKeepScreenAwake}
          />
          <SettingRow
            title="阅读时允许横屏"
            value={allowLandscape}
            onValueChange={setAllowLandscape}
          />
          <SettingRow
            title="正文首行缩进"
            value={bookFirstLineIndent}
            onValueChange={setBookFirstLineIndent}
          />
          <SettingRow
            title="点击左侧翻到下一页"
            value={leftTapNext}
            onValueChange={setLeftTapNext}
          />

          <View style={[styles.scaleSection, styles.scaleSectionDivider, { borderBottomColor: theme.rule }]}>
            <Text numberOfLines={1} style={[styles.scaleTitle, { color: theme.ink, fontFamily: theme.serif }]}>阅读方式</Text>
            <View style={styles.scaleRow}>
              {([
                { value: "paged" as const, label: "翻页" },
                { value: "scroll" as const, label: "滚动" },
              ]).map((option) => {
                const selected = option.value === bookReadingMode;
                return (
                  <Pressable
                    key={option.value}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => {
                      setBookReadingMode(option.value);
                      void selectionHaptic(hapticsEnabled);
                    }}
                    style={[
                      styles.scaleButton,
                      { borderColor: selected ? theme.red : theme.rule, backgroundColor: selected ? theme.red : theme.paper },
                    ]}
                  >
                    <Text style={[styles.scaleButtonText, { color: selected ? theme.inverse : theme.ink, fontFamily: theme.sans }]}>{option.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <View style={styles.scaleSection}>
            <Text numberOfLines={1} style={[styles.scaleTitle, { color: theme.ink, fontFamily: theme.serif }]}>阅读页字号</Text>
            <View style={styles.scaleRow}>
              {([
                { value: 0.9 as const, label: "紧凑" },
                { value: 1 as const, label: "标准" },
                { value: 1.12 as const, label: "大字" },
              ]).map((option) => {
                const selected = option.value === textScale;
                return (
                  <Pressable
                    key={option.value}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => {
                      setTextScale(option.value);
                      void selectionHaptic(hapticsEnabled);
                    }}
                    style={[
                      styles.scaleButton,
                      { borderColor: selected ? theme.red : theme.rule, backgroundColor: selected ? theme.red : theme.paper },
                    ]}
                  >
                    <Text style={[styles.scaleButtonText, { color: selected ? theme.inverse : theme.ink, fontFamily: theme.sans }]}>{option.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <View style={[styles.scaleSection, styles.scaleSectionTopDivider, { borderTopColor: theme.rule }]}>
            <Text numberOfLines={1} style={[styles.scaleTitle, { color: theme.ink, fontFamily: theme.serif }]}>行距</Text>
            <View style={styles.scaleRow}>
              {([1.75, 1.95, 2.15] as const).map((value, index) => {
                const selected = value === bookLineHeight;
                return (
                  <Pressable
                    key={value}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => {
                      setBookLineHeight(value);
                      void selectionHaptic(hapticsEnabled);
                    }}
                    style={[
                      styles.scaleButton,
                      { borderColor: selected ? theme.red : theme.rule, backgroundColor: selected ? theme.red : theme.paper },
                    ]}
                  >
                    <Text style={[styles.scaleButtonText, { color: selected ? theme.inverse : theme.ink, fontFamily: theme.sans }]}>{["紧凑", "标准", "宽松"][index]}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
            </View>
          </>
        ) : null}

        {!section || section === "interaction" ? (
          <View style={!section ? styles.sectionGap : undefined}>
          <SectionTitle title="交互设置" />
          <View style={[styles.panel, { backgroundColor: theme.paper, borderColor: theme.rule }]}>
            <SettingRow
              title="触感反馈"
              value={hapticsEnabled}
              onValueChange={(value) => {
                setHapticsEnabled(value);
                void selectionHaptic(value);
              }}
            />
          </View>
        </View>
        ) : null}

        {!section || section === "data" ? (
          <View style={!section ? styles.sectionGap : undefined}>
          <SectionTitle title="阅读数据" aside={`${recentIssues.length + recentBooks.length} 条`} />
          <View style={[styles.panel, { backgroundColor: theme.paper, borderColor: theme.rule }]}>
            <Pressable
              onPress={() => Alert.alert("清除阅读记录？", undefined, [
                { text: "取消", style: "cancel" },
                { text: "清除", style: "destructive", onPress: clearRecentReading },
              ])}
              disabled={!recentIssues.length && !recentBooks.length}
              style={[styles.actionRow, { opacity: recentIssues.length || recentBooks.length ? 1 : 0.4 }]}
            >
              <Text style={[styles.actionText, { color: theme.ink, fontFamily: theme.serif }]}>清除继续阅读记录</Text>
              <Ionicons name="chevron-forward" size={17} color={theme.muted} />
            </Pressable>
          </View>
        </View>
        ) : null}

        {!section || section === "about" ? (
          <View style={!section ? styles.sectionGap : undefined}>
          <SectionTitle title="关于" />
          <View style={[styles.panel, { backgroundColor: theme.paper, borderColor: theme.rule }]}>
            <View style={[styles.about, { borderBottomColor: theme.rule }]}>
              <Text style={[styles.aboutTitle, { color: theme.ink, fontFamily: theme.serif }]}>JOJO 看报</Text>
              <Text style={[styles.aboutVersion, { color: theme.muted, fontFamily: theme.sans }]}>{nativeApplicationVersion ?? "0.0.1-rc1"}</Text>
            </View>
            <Pressable onPress={() => void Linking.openURL(ARCHIVE_WEB_ORIGIN)} style={styles.actionRow}>
              <Text style={[styles.actionText, { color: theme.ink, fontFamily: theme.serif }]}>在浏览器打开 JOJO 看报</Text>
              <Ionicons name="open-outline" size={17} color={theme.muted} />
            </Pressable>
          </View>
        </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: { width: "100%", maxWidth: 760, alignSelf: "center", padding: 18, paddingBottom: 42 },
  panel: { marginTop: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14 },
  settingRow: { minHeight: 62, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center" },
  settingCopy: { flex: 1, paddingRight: 12 },
  settingTitle: { fontSize: 14, fontWeight: "800" },
  scaleSection: { minHeight: 66, flexDirection: "row", alignItems: "center" },
  scaleSectionDivider: { borderBottomWidth: StyleSheet.hairlineWidth },
  scaleSectionTopDivider: { borderTopWidth: StyleSheet.hairlineWidth },
  scaleTitle: { width: 112, fontSize: 14, fontWeight: "800" },
  scaleRow: { flex: 1, flexDirection: "row", gap: 5 },
  scaleButton: { height: 34, flex: 1, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  scaleButtonText: { fontSize: 10, fontWeight: "900" },
  sectionGap: { marginTop: 26 },
  actionRow: { minHeight: 58, flexDirection: "row", alignItems: "center" },
  actionText: { flex: 1, fontSize: 13, fontWeight: "800" },
  about: { minHeight: 58, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center" },
  aboutTitle: { flex: 1, fontSize: 13, fontWeight: "800" },
  aboutVersion: { fontSize: 10, fontWeight: "700" },
});
