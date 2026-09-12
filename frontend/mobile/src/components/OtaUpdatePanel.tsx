import * as Clipboard from "expo-clipboard";
import * as Updates from "expo-updates";
import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { mobileTheme } from "../theme/tokens";

export function OtaUpdatePanel() {
  const update = Updates.useUpdates();
  const running = update.currentlyRunning;
  const [operation, setOperation] = useState<"check" | "download" | "restart">();
  const [prepared, setPrepared] = useState(false);
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  const operationRef = useRef(false);
  const pending = update.isUpdatePending || prepared;
  const enabled = Updates.isEnabled && !__DEV__;
  const busy = Boolean(operation || update.isChecking || update.isDownloading || update.isRestarting || update.isStartupProcedureRunning);
  const theme = mobileTheme;
  const createdAt = running.createdAt?.toLocaleString("zh-CN", { hour12: false });
  const identity = running.isEmbeddedLaunch ? "安装包内置版本" : createdAt || "已安装热更新";
  const updateError = failure || (update.downloadError ? "热更新下载失败，请检查网络后重试。" : update.checkError ? "热更新检查失败，请检查网络后重试。" : "");
  const status = !enabled ? "此运行环境未启用热更新。"
    : operation === "restart" || update.isRestarting ? "正在重启应用…"
    : operation === "download" || update.isDownloading ? "正在下载热更新…"
    : operation === "check" || update.isChecking ? "正在检查热更新…"
    : update.isStartupProcedureRunning ? "正在检查启动更新…"
    : failure ? failure
    : pending ? "热更新已下载，重启应用后生效。"
    : updateError || message || "热更新不会改变上方的安装包版本号。";

  async function checkOrApply() {
    if (!enabled || busy || operationRef.current) return;
    operationRef.current = true;
    setFailure("");
    setMessage("");
    if (pending) {
      setOperation("restart");
      try {
        await Updates.reloadAsync();
        // A successful reload replaces this JS runtime. Do not enqueue state
        // changes after it; only restore the button when restarting fails.
      } catch {
        setFailure("重启失败，请彻底退出应用后重新打开，或重试。");
        setOperation(undefined);
        operationRef.current = false;
      }
      return;
    }
    let stage: "check" | "download" = "check";
    try {
      setOperation("check");
      const result = await Updates.checkForUpdateAsync();
      if (!result.isAvailable && !result.isRollBackToEmbedded) {
        setMessage(result.reason === "updatePreviouslyFailed"
          ? "新热更新曾启动失败，当前仍在使用原版本。请反馈版本信息。"
          : "本次未发现可用热更新。");
        return;
      }
      stage = "download";
      setOperation("download");
      const downloaded = await Updates.fetchUpdateAsync();
      if (downloaded.isNew || downloaded.isRollBackToEmbedded) setPrepared(true);
      else setMessage("未下载到可用热更新，请重新检查。");
    } catch {
      setFailure(stage === "download" ? "热更新下载失败，请检查网络后重试。" : "热更新检查失败，请检查网络后重试。");
    } finally {
      setOperation(undefined);
      operationRef.current = false;
    }
  }

  async function copyVersion() {
    try {
      await Clipboard.setStringAsync([
        `当前热更新：${identity}`,
        `版本标识：${running.updateId || "无"}`,
        `更新通道：${running.channel || "无"}`,
        `兼容版本：${running.runtimeVersion || "无"}`,
        `启动回退：${running.isEmergencyLaunch ? "是" : "否"}`,
        `有待应用更新：${pending ? "是" : "否"}`,
        `状态：${status}`,
      ].join("\n"));
      setCopyNotice("版本信息已复制。");
    } catch {
      setCopyNotice("复制失败，可长按上方版本标识复制。");
    }
  }

  return <View style={[styles.panel, { borderBottomColor: theme.rule }]}>
    <Text style={[styles.title, { color: theme.ink, fontFamily: theme.serif }]}>当前热更新</Text>
    <Text selectable style={[styles.detail, { color: theme.ink, fontFamily: theme.sans }]}>{identity}</Text>
    {running.updateId ? <Text selectable style={[styles.detail, { color: theme.muted, fontFamily: theme.sans }]}>{`版本标识：${running.updateId}`}</Text> : null}
    {running.isEmergencyLaunch ? <Text style={[styles.detail, { color: theme.red, fontFamily: theme.sans }]}>上次更新启动异常，当前已回退到可用版本。</Text> : null}
    <Text accessibilityLiveRegion="polite" style={[styles.detail, { color: updateError ? theme.red : theme.muted, fontFamily: theme.sans }]}>{status}</Text>
    <View style={styles.actions}>
      {enabled ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => void checkOrApply()} style={[styles.button, { borderColor: theme.red, opacity: busy ? 0.5 : 1 }]}>
        {busy ? <ActivityIndicator size="small" color={theme.red} /> : null}
        <Text style={[styles.buttonText, { color: theme.red, fontFamily: theme.sans }]}>{pending ? "重启并应用热更新" : "检查热更新"}</Text>
      </Pressable> : null}
      <Pressable accessibilityRole="button" onPress={() => void copyVersion()} style={[styles.button, { borderColor: theme.rule }]}>
        <Text style={[styles.buttonText, { color: theme.ink, fontFamily: theme.sans }]}>复制版本信息</Text>
      </Pressable>
    </View>
    {copyNotice ? <Text accessibilityLiveRegion="polite" style={[styles.detail, { color: theme.muted, fontFamily: theme.sans }]}>{copyNotice}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  panel: { paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { fontSize: 14, fontWeight: "800" },
  detail: { fontSize: 12, lineHeight: 19, marginTop: 6 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 12 },
  button: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 10, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  buttonText: { fontSize: 12, fontWeight: "700" },
});
