import Ionicons from "@expo/vector-icons/Ionicons";
import { ARCHIVE_WEB_ORIGIN, type TimesSourceRef } from "@jojo/content";
import { useNavigation, useRoute, type NavigationProp, type RouteProp } from "@react-navigation/native";
import { nativeApplicationVersion } from "expo-application";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
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
import { checkNativeAppUpdate, openNativeAppUpdate } from "../lib/appUpdate";
import { selectionHaptic, toggleHaptic } from "../lib/haptics";
import { mobileTimesApi, timesSourceName } from "../lib/times";
import type { RootStackParamList, SettingsSection } from "../navigation/types";
import { useMobileStore } from "../store/mobileStore";
import { mobileTheme } from "../theme/tokens";

function SettingRow({
  title,
  description,
  value,
  disabled = false,
  onValueChange,
}: {
  title: string;
  description?: string;
  value: boolean;
  disabled?: boolean;
  onValueChange: (value: boolean) => void;
}) {
  const theme = mobileTheme;
  return (
    <View style={[styles.settingRow, { borderBottomColor: theme.rule }]}>
      <View style={styles.settingCopy}>
        <Text style={[styles.settingTitle, { color: theme.ink, fontFamily: theme.serif }]}>{title}</Text>
        {description ? <Text style={[styles.settingDescription, { color: theme.muted, fontFamily: theme.sans }]}>{description}</Text> : null}
      </View>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onValueChange}
        trackColor={{ false: theme.rule, true: theme.red }}
        thumbColor={theme.paper}
        ios_backgroundColor={theme.rule}
      />
    </View>
  );
}

export function SettingsScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
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
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string>();
  const timesLanguage = useMobileStore((state) => state.timesLanguage);
  const setTimesLanguage = useMobileStore((state) => state.setTimesLanguage);
  const timesDisabledSourceIds = useMobileStore((state) => state.timesDisabledSourceIds);
  const setTimesSourceEnabled = useMobileStore((state) => state.setTimesSourceEnabled);
  const setAllTimesSourcesEnabled = useMobileStore((state) => state.setAllTimesSourcesEnabled);
  const enableAllTimesSources = useMobileStore((state) => state.enableAllTimesSources);
  const [timesSources, setTimesSources] = useState<TimesSourceRef[]>([]);
  const [timesSourcesError, setTimesSourcesError] = useState("");
  const theme = mobileTheme;
  const disabledTimesSources = useMemo(() => new Set(timesDisabledSourceIds), [timesDisabledSourceIds]);
  const timesSourceIds = useMemo(() => timesSources.map((source) => source.id), [timesSources]);
  const enabledTimesSourceCount = timesSources.filter((source) => !disabledTimesSources.has(source.id)).length;
  const allTimesSourcesEnabled = Boolean(timesSources.length) && enabledTimesSourceCount === timesSources.length;
  const titles: Record<SettingsSection, string> = {
    reading: "阅读设置",
    interaction: "交互设置",
    times: "时事设置",
    data: "阅读数据",
    about: "关于",
  };

  const checkInstallerUpdate = async () => {
    setUpdateBusy(true);
    setUpdateMessage("正在检查应用更新…");
    const catalog = await checkNativeAppUpdate();
    setUpdateBusy(false);
    if (!catalog) {
      setUpdateMessage("暂未发现可用更新");
      return;
    }
    setUpdateMessage(`发现新版本 ${catalog.version}`);
    const download = { text: "下载更新", onPress: () => void openNativeAppUpdate(catalog) };
    Alert.alert(
      `发现新版本 ${catalog.version}`,
      [catalog.notes, "下载完成后，打开安装包，按提示完成更新。"].filter(Boolean).join("\n\n"),
      catalog.mandatory ? [download] : [{ text: "稍后", style: "cancel" }, download],
      { cancelable: !catalog.mandatory },
    );
  };

  useEffect(() => {
    if (section && section !== "times") return undefined;
    let active = true;
    setTimesSourcesError("");
    void mobileTimesApi.timelineIndex()
      .then((index) => { if (active) setTimesSources(index.sources); })
      .catch((reason: unknown) => {
        if (active) setTimesSourcesError(reason instanceof Error ? reason.message : "媒体列表暂时无法载入");
      });
    return () => { active = false; };
  }, [section]);

  useEffect(() => {
    if (timesSources.length && enabledTimesSourceCount === 0) enableAllTimesSources();
  }, [enableAllTimesSources, enabledTimesSourceCount, timesSources.length]);

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
            onValueChange={(value) => {
              setKeepScreenAwake(value);
              void toggleHaptic(hapticsEnabled, value);
            }}
          />
          <SettingRow
            title="阅读时允许横屏"
            value={allowLandscape}
            onValueChange={(value) => {
              setAllowLandscape(value);
              void toggleHaptic(hapticsEnabled, value);
            }}
          />
          <SettingRow
            title="正文首行缩进"
            value={bookFirstLineIndent}
            onValueChange={(value) => {
              setBookFirstLineIndent(value);
              void toggleHaptic(hapticsEnabled, value);
            }}
          />
          <SettingRow
            title="点击左侧翻到下一页"
            value={leftTapNext}
            onValueChange={(value) => {
              setLeftTapNext(value);
              void toggleHaptic(hapticsEnabled, value);
            }}
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
              description="切换页面、翻页、打开内容与调整选项时提供触感"
              value={hapticsEnabled}
              onValueChange={(value) => {
                setHapticsEnabled(value);
                void toggleHaptic(hapticsEnabled || value, value);
              }}
            />
          </View>
        </View>
        ) : null}

        {!section || section === "times" ? (
          <View style={!section ? styles.sectionGap : undefined}>
            <SectionTitle title="时事设置" />
            <View style={[styles.panel, { backgroundColor: theme.paper, borderColor: theme.rule }]}>
              <View style={styles.scaleSection}>
                <View style={styles.timesSettingCopy}>
                  <Text numberOfLines={1} style={[styles.scaleTitle, styles.timesSettingTitle, { color: theme.ink, fontFamily: theme.serif }]}>外文内容</Text>
                  <Text style={[styles.timesSettingHint, { color: theme.muted, fontFamily: theme.sans }]}>默认显示中文译文或出版方原文</Text>
                </View>
                <View style={styles.scaleRow}>
                  {([
                    { value: "zh-CN" as const, label: "中文" },
                    { value: "original" as const, label: "原文" },
                  ]).map((option) => {
                    const selected = option.value === timesLanguage;
                    return (
                      <Pressable
                        key={option.value}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        onPress={() => {
                          setTimesLanguage(option.value);
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
              <View style={[styles.sourceSettings, { borderTopColor: theme.rule }]}>
                <SettingRow
                  title="全部媒体"
                  description={timesSources.length
                    ? allTimesSourcesEnabled ? "所有来源均显示" : `已开启 ${enabledTimesSourceCount} / ${timesSources.length} 个`
                    : "正在载入媒体列表…"}
                  value={allTimesSourcesEnabled}
                  disabled={timesSources.length <= 1}
                  onValueChange={(enabled) => {
                    setAllTimesSourcesEnabled(enabled, timesSourceIds);
                    void toggleHaptic(hapticsEnabled, enabled);
                  }}
                />
                {timesSources.map((source) => {
                  const enabled = !disabledTimesSources.has(source.id);
                  return (
                    <SettingRow
                      key={source.id}
                      title={timesSourceName(source)}
                      description={source.language === "zh-CN" ? "中文" : "外文"}
                      value={enabled}
                      disabled={enabled && enabledTimesSourceCount === 1}
                      onValueChange={(nextEnabled) => {
                        setTimesSourceEnabled(source.id, nextEnabled, timesSourceIds);
                        void toggleHaptic(hapticsEnabled, nextEnabled);
                      }}
                    />
                  );
                })}
                {!timesSources.length && !timesSourcesError && !IS_EINK_RELEASE ? <ActivityIndicator color={theme.red} style={styles.sourceLoading} /> : null}
                {timesSourcesError ? <Text accessibilityRole="alert" style={[styles.sourceError, { color: theme.red, fontFamily: theme.sans }]}>{timesSourcesError}</Text> : null}
              </View>
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
              <Text style={[styles.aboutVersion, { color: theme.muted, fontFamily: theme.sans }]}>{nativeApplicationVersion ?? "0.0.1"}</Text>
            </View>
            {Platform.OS === "android" ? (
              <Pressable
                accessibilityRole="button"
                disabled={updateBusy}
                onPress={() => void checkInstallerUpdate()}
                style={[styles.actionRow, styles.actionRowDivider, { borderBottomColor: theme.rule, opacity: updateBusy ? 0.5 : 1 }]}
              >
                <Text style={[styles.actionText, { color: theme.ink, fontFamily: theme.serif }]}>检查应用更新</Text>
                <Ionicons name="download-outline" size={17} color={theme.muted} />
              </Pressable>
            ) : null}
            {updateMessage ? (
              <Text style={[styles.updateMessage, { color: theme.muted, borderBottomColor: theme.rule, fontFamily: theme.sans }]}>
                {updateMessage}
              </Text>
            ) : null}
            <Pressable onPress={() => void Linking.openURL(ARCHIVE_WEB_ORIGIN)} style={styles.actionRow}>
              <Text style={[styles.actionText, { color: theme.ink, fontFamily: theme.serif }]}>在浏览器打开 JOJO 看报</Text>
              <Ionicons name="open-outline" size={17} color={theme.muted} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityHint="查看本项目与第三方软件的许可信息"
              onPress={() => navigation.navigate("OpenSourceLicenses")}
              style={({ pressed }) => [styles.actionRow, styles.actionRowTopDivider, { borderTopColor: theme.rule, opacity: pressed ? 0.6 : 1 }]}
            >
              <Text style={[styles.actionText, { color: theme.ink, fontFamily: theme.serif }]}>开源软件许可</Text>
              <Ionicons name="chevron-forward" size={17} color={theme.muted} />
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
  settingDescription: { marginTop: 3, fontSize: 9, lineHeight: 14, fontWeight: "700" },
  scaleSection: { minHeight: 66, flexDirection: "row", alignItems: "center" },
  scaleSectionDivider: { borderBottomWidth: StyleSheet.hairlineWidth },
  scaleSectionTopDivider: { borderTopWidth: StyleSheet.hairlineWidth },
  scaleTitle: { width: 112, fontSize: 14, fontWeight: "800" },
  timesSettingCopy: { width: 150, paddingRight: 10 },
  timesSettingTitle: { width: "auto" },
  timesSettingHint: { marginTop: 3, fontSize: 9, lineHeight: 14 },
  sourceSettings: { position: "relative", borderTopWidth: StyleSheet.hairlineWidth },
  sourceLoading: { position: "absolute", top: 20, left: 116 },
  sourceError: { paddingVertical: 14, fontSize: 10, lineHeight: 17, fontWeight: "800" },
  scaleRow: { flex: 1, flexDirection: "row", gap: 5 },
  scaleButton: { height: 34, flex: 1, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  scaleButtonText: { fontSize: 10, fontWeight: "900" },
  sectionGap: { marginTop: 26 },
  actionRow: { minHeight: 58, flexDirection: "row", alignItems: "center" },
  actionRowDivider: { borderBottomWidth: StyleSheet.hairlineWidth },
  actionRowTopDivider: { borderTopWidth: StyleSheet.hairlineWidth },
  actionText: { flex: 1, fontSize: 13, fontWeight: "800" },
  updateMessage: { minHeight: 42, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 12, fontSize: 11, lineHeight: 17 },
  about: { minHeight: 58, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center" },
  aboutTitle: { flex: 1, fontSize: 13, fontWeight: "800" },
  aboutVersion: { fontSize: 10, fontWeight: "700" },
});
