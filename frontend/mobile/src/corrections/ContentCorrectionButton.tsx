import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { contentCorrectionCategoryLabels, contentCorrectionStatusLabels, createCorrectionRequestId } from "@jojo/auth";
import type { ContentCorrection, ContentCorrectionCategory, ContentCorrectionSource } from "@jojo/auth";
import { useMobileAuthStore } from "../account/auth";
import { mobileTheme, type MobileTheme } from "../theme/tokens";
import { mobileContentCorrections } from "./api";

export interface ContentCorrectionButtonProps {
  source: ContentCorrectionSource;
  onLogin: () => void;
  theme?: MobileTheme;
  label?: string;
}

export function ContentCorrectionButton({ source, onLogin, theme = mobileTheme, label = "内容纠错" }: ContentCorrectionButtonProps) {
  const [snapshot, setSnapshot] = useState<ContentCorrectionSource | null>(null);
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => setSnapshot({ ...source })} style={styles.trigger}><Text style={{ color: theme.red, fontFamily: theme.serif }}>{label}</Text></Pressable>
    {snapshot ? <ContentCorrectionDialog source={snapshot} onClose={() => setSnapshot(null)} onLogin={() => { setSnapshot(null); onLogin(); }} theme={theme} /> : null}
  </>;
}

export function ContentCorrectionDialog({ source, onClose, onLogin, theme = mobileTheme }: {
  source: ContentCorrectionSource; onClose: () => void; onLogin: () => void; theme?: MobileTheme;
}) {
  const userId = useMobileAuthStore((state) => state.user?.id);
  const initialized = useMobileAuthStore((state) => state.initialized);
  const requestId = useRef(createCorrectionRequestId());
  const submitting = useRef(false);
  const mounted = useRef(true);
  const initialOwner = useRef(userId);
  const currentOwner = useRef(userId);
  currentOwner.current = userId;
  const [category, setCategory] = useState<ContentCorrectionCategory>("typo");
  const [details, setDetails] = useState("");
  const [quote, setQuote] = useState(source.quote || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<ContentCorrection | null>(null);
  const [history, setHistory] = useState<ContentCorrection[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const foreground = { color: theme.ink, fontFamily: theme.serif };
  const fieldStyle = [styles.field, foreground, { backgroundColor: theme.paper, borderColor: theme.rule }];
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (initialOwner.current !== userId) {
      setDetails(""); setQuote(""); setSaved(null); setHistory([]); setError("");
      onClose();
    }
  }, [userId, onClose]);
  useEffect(() => {
    let active = true;
    setHistory([]);
    setHistoryError("");
    if (userId) void mobileContentCorrections.list(source).then((items) => { if (active) setHistory(items); })
      .catch(() => { if (active) setHistoryError("暂时无法读取此前的纠错记录。"); });
    return () => { active = false; };
  }, [source.contentType, source.contentId, userId]);
  async function submit() {
    if (submitting.current || !userId) return;
    const owner = userId;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await mobileContentCorrections.submit({ ...source, quote }, category, details, requestId.current, owner);
      if (!mounted.current || currentOwner.current !== owner) return;
      setSaved(result);
      setHistory((items) => [result, ...items.filter((item) => item.id !== result.id)]);
    } catch (cause) { if (mounted.current && currentOwner.current === owner) setError(cause instanceof Error ? cause.message : "提交失败，请重试。"); }
    finally { submitting.current = false; if (mounted.current && currentOwner.current === owner) setBusy(false); }
  }
  if (initialOwner.current !== userId) return null;
  return <Modal visible transparent animationType={theme.eInk ? "none" : "fade"} onRequestClose={() => { if (!busy) onClose(); }}>
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.backdrop}>
      <View accessibilityViewIsModal style={[styles.dialog, { backgroundColor: theme.paper, borderColor: theme.red }]}>
        <View style={styles.header}><Text accessibilityRole="header" style={[styles.title, foreground]}>内容纠错</Text><Pressable accessibilityRole="button" accessibilityLabel="关闭内容纠错" disabled={busy} onPress={onClose} style={styles.close}><Text style={foreground}>关闭</Text></Pressable></View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <Text style={[styles.source, foreground]}>{source.contentTitle}</Text>
          {source.locationLabel || source.sectionId ? <Text style={{ color: theme.muted }}>{source.locationLabel || source.sectionId}</Text> : null}
          {!initialized ? <Text style={foreground}>正在确认登录状态…</Text> : !userId ? <>
            <Text style={[styles.description, foreground]}>登录后可提交纠错，并查看处理结果。当前阅读位置会保留。</Text>
            <Pressable accessibilityRole="button" onPress={onLogin} style={[styles.submit, { backgroundColor: theme.red }]}><Text style={{ color: theme.inverse }}>登录后纠错</Text></Pressable>
          </> : saved ? <View accessibilityLiveRegion="polite"><Text style={[styles.success, { color: theme.red }]}>纠错已记录</Text><Text style={[styles.description, foreground]}>感谢你帮助完善资料。再次打开这里可查看处理结果。</Text><Text style={foreground}>编号：{saved.id.slice(0, 8)} · {contentCorrectionStatusLabels[saved.status]}</Text><Pressable accessibilityRole="button" onPress={onClose} style={[styles.submit, { backgroundColor: theme.red }]}><Text style={{ color: theme.inverse }}>继续阅读</Text></Pressable></View> : <>
            <Text style={[styles.label, foreground]}>问题类型</Text>
            <View style={styles.categories}>{Object.entries(contentCorrectionCategoryLabels).map(([value, label]) => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: category === value, disabled: busy }} disabled={busy} onPress={() => setCategory(value as ContentCorrectionCategory)} style={[styles.category, { borderColor: category === value ? theme.red : theme.rule, backgroundColor: category === value ? theme.paperSoft : theme.paper }]}><Text style={{ color: category === value ? theme.red : theme.ink }}>{label}</Text></Pressable>)}</View>
            <Text style={[styles.label, foreground]}>问题说明</Text>
            <TextInput accessibilityLabel="问题说明" multiline editable={!busy} value={details} maxLength={2000} onChangeText={setDetails} placeholder="说明错字、缺页或其他问题，方便编辑核查" placeholderTextColor={theme.muted} style={[...fieldStyle, styles.details]} />
            <Text style={[styles.label, foreground]}>原文摘录（可选）</Text>
            <TextInput accessibilityLabel="原文摘录（可选）" multiline editable={!busy} value={quote} maxLength={4000} onChangeText={setQuote} placeholder="粘贴有问题的原文" placeholderTextColor={theme.muted} style={[...fieldStyle, styles.quote]} />
            <Text style={[styles.description, { color: theme.muted }]}>提交会附上资料名称和当前阅读位置，仅你与编辑可查看。</Text>
            {error ? <Text accessibilityRole="alert" style={{ color: theme.red }}>{error}</Text> : null}
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || details.trim().length < 2 }} disabled={busy || details.trim().length < 2} onPress={() => void submit()} style={[styles.submit, { backgroundColor: theme.red, opacity: busy || details.trim().length < 2 ? .5 : 1 }]}><Text style={{ color: theme.inverse }}>{busy ? "正在提交…" : "提交纠错"}</Text></Pressable>
          </>}
          {userId && (history.length > 0 || historyError) ? <View style={[styles.history, { borderColor: theme.rule }]}>
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: showHistory }} onPress={() => setShowHistory(!showHistory)}><Text style={foreground}>我对这份资料的纠错（{history.length}）{showHistory ? " −" : " +"}</Text></Pressable>
            {showHistory ? <>{historyError ? <Text style={foreground}>{historyError}</Text> : history.map((item) => <View key={item.id} style={styles.historyItem}><Text style={{ color: theme.red }}>{contentCorrectionStatusLabels[item.status]} · {new Date(item.createdAt).toLocaleDateString("zh-CN")}</Text><Text style={[styles.description, foreground]}>{item.details}</Text>{item.resolutionNote ? <Text style={foreground}>编辑答复：{item.resolutionNote}</Text> : null}</View>)}</> : null}
          </View> : null}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create({
  trigger: { minHeight: 44, paddingHorizontal: 10, justifyContent: "center" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,.45)", justifyContent: "center", alignItems: "center", padding: 20 },
  dialog: { width: "100%", maxWidth: 560, maxHeight: "90%", borderWidth: 2 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 18, paddingTop: 8 },
  title: { fontSize: 22, fontWeight: "700" }, close: { paddingVertical: 16, paddingLeft: 20 },
  content: { padding: 18, paddingTop: 8 }, source: { fontWeight: "700", fontSize: 16, lineHeight: 25 },
  label: { marginTop: 20, marginBottom: 10, fontWeight: "600" },
  categories: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, category: { borderWidth: 1, padding: 10 },
  field: { borderWidth: 1, fontSize: 15, padding: 12, textAlignVertical: "top" }, details: { minHeight: 100 }, quote: { minHeight: 72 },
  description: { lineHeight: 24, marginVertical: 12, fontSize: 14 },
  submit: { minHeight: 46, alignItems: "center", justifyContent: "center", padding: 12, marginTop: 16 },
  success: { fontSize: 22, marginTop: 20 }, history: { borderTopWidth: 1, marginTop: 24, paddingTop: 18 }, historyItem: { marginTop: 18 },
});
