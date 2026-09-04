import type { PersonalInvitationStatus } from "@jojo/auth";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { mobilePersonalInvitationRepository } from "../account/auth";
import { IS_EINK_RELEASE } from "../config/appVariant";
import { mobileTheme } from "../theme/tokens";

function expiryLabel(value: string | null): string {
  if (!value) return "长期有效";
  return `有效至 ${new Date(value).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })}`;
}

export function PersonalInvitationPanel({ userId }: { userId: string }) {
  const theme = mobileTheme;
  const [status, setStatus] = useState<PersonalInvitationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setNotice("");
    try {
      setStatus(await mobilePersonalInvitationRepository.getStatus());
    } catch {
      setNotice("邀请码暂时无法读取");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, userId]);

  const generate = async () => {
    setGenerating(true);
    setNotice("");
    try {
      const invitation = await mobilePersonalInvitationRepository.generate();
      setStatus({ allocated: true, code: invitation.code, expires_at: invitation.expires_at, redeemed: false, disabled: false });
    } catch {
      setNotice("邀请码暂时无法生成，请稍后重试");
    } finally {
      setGenerating(false);
    }
  };

  const expired = status?.allocated && status.expires_at
    ? new Date(status.expires_at).getTime() <= Date.now()
    : false;
  const unavailable = status?.allocated && (status.redeemed || status.disabled || expired);
  const lifecycle = status?.allocated
    ? status.disabled ? "已停用" : status.redeemed ? "已使用" : expired ? "已过期" : expiryLabel(status.expires_at)
    : "";

  return (
    <View style={[styles.panel, { borderColor: theme.rule, backgroundColor: theme.paper }]}>
      {loading ? (
        <View style={styles.loading}>
          {!IS_EINK_RELEASE ? <ActivityIndicator color={theme.red} size="small" /> : null}
          <Text style={[styles.hint, { color: theme.muted, fontFamily: theme.sans }]}>正在读取邀请码…</Text>
        </View>
      ) : status?.allocated ? (
        <View style={styles.content}>
          <View style={styles.codeRow}>
            <Text accessibilityLabel={`邀请码 ${status.code}`} style={[styles.code, { color: unavailable ? theme.muted : theme.red, fontFamily: theme.serif }]}>{status.code}</Text>
            {!unavailable ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => void Clipboard.setStringAsync(status.code).then(() => setNotice("已复制"))}
                style={[styles.textButton, { borderBottomColor: theme.red }]}
              >
                <Text style={[styles.textButtonLabel, { color: theme.red, fontFamily: theme.sans }]}>复制</Text>
              </Pressable>
            ) : null}
          </View>
          <Text style={[styles.hint, { color: theme.muted, fontFamily: theme.sans }]}>{lifecycle}</Text>
          {expired && !status.disabled && !status.redeemed ? (
            <Pressable disabled={generating} onPress={() => void generate()} style={[styles.primaryButton, { backgroundColor: theme.red, opacity: generating ? 0.5 : 1 }]}>
              <Text style={[styles.primaryLabel, { color: theme.inverse, fontFamily: theme.serif }]}>{generating ? "正在生成…" : "重新生成邀请码"}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <View style={styles.emptyRow}>
          <Text style={[styles.emptyCopy, { color: theme.muted, fontFamily: theme.sans }]}>可邀请一位新读者，30 天内有效。</Text>
          <Pressable disabled={generating} onPress={() => void generate()} style={[styles.primaryButton, { backgroundColor: theme.red, opacity: generating ? 0.5 : 1 }]}>
            <Text style={[styles.primaryLabel, { color: theme.inverse, fontFamily: theme.serif }]}>{generating ? "正在生成…" : "生成邀请码"}</Text>
          </Pressable>
        </View>
      )}
      {notice ? <Text accessibilityRole="alert" style={[styles.notice, { color: notice === "已复制" ? theme.ink : theme.red, borderLeftColor: theme.red, fontFamily: theme.sans }]}>{notice}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { marginTop: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 15 },
  loading: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9 },
  content: { minHeight: 58, justifyContent: "center" },
  codeRow: { flexDirection: "row", alignItems: "center", gap: 18 },
  code: { flex: 1, fontSize: 27, fontWeight: "900", letterSpacing: 5 },
  hint: { marginTop: 5, fontSize: 10, lineHeight: 17, fontWeight: "700" },
  textButton: { borderBottomWidth: 1, paddingVertical: 5 },
  textButtonLabel: { fontSize: 10, fontWeight: "900" },
  emptyRow: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: 12 },
  emptyCopy: { flex: 1, fontSize: 10, lineHeight: 17, fontWeight: "700" },
  primaryButton: { minHeight: 40, alignItems: "center", justifyContent: "center", paddingHorizontal: 14 },
  primaryLabel: { fontSize: 11, fontWeight: "900" },
  notice: { marginTop: 12, borderLeftWidth: 2, paddingLeft: 9, fontSize: 10, lineHeight: 17, fontWeight: "800" },
});
