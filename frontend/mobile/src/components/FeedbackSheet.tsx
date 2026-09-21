import { submitFeedback, type FeedbackTopic } from "@jojo/analytics/feedback";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { MobileTheme } from "../theme/tokens";

export interface FeedbackCorrection {
  quote: string;
  contentType: "book" | "periodical" | "times_article";
  contentId?: string;
  contentTitle?: string;
  section?: string;
}

const TOPICS: Array<{ value: Exclude<FeedbackTopic, "content_correction">; label: string }> = [
  { value: "bug", label: "功能异常" },
  { value: "suggestion", label: "功能建议" },
  { value: "other", label: "其他" },
];

/** One sheet for both entries: a correction quoting selected text, or a free
 * problem report and suggestion from settings. */
export function FeedbackSheet({ visible, correction, screen, onClose, theme }: {
  visible: boolean;
  correction?: FeedbackCorrection;
  screen?: string;
  onClose: () => void;
  theme: MobileTheme;
}) {
  const [topic, setTopic] = useState<Exclude<FeedbackTopic, "content_correction">>("bug");
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const progress = useRef(new Animated.Value(0)).current;
  const canSend = Boolean(message.trim()) && !sending && !sent;

  useEffect(() => () => clearTimeout(timer.current), []);

  // Fade the scrim and slide only the panel: a slide-animated Modal would push
  // the full-screen scrim up from the bottom as well, which reads as a shadow
  // sweeping over the page.
  useEffect(() => {
    if (!visible) return;
    progress.setValue(0);
    Animated.timing(progress, {
      toValue: 1,
      duration: theme.eInk ? 0 : 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible, progress, theme.eInk]);

  const finishClose = () => {
    clearTimeout(timer.current);
    setMessage("");
    setNotice("");
    setSent(false);
    onClose();
  };

  const close = () => {
    if (sending) return;
    if (theme.eInk) { finishClose(); return; }
    Animated.timing(progress, { toValue: 0, duration: 170, easing: Easing.in(Easing.cubic), useNativeDriver: true })
      .start(() => finishClose());
  };

  function send() {
    if (!canSend) return;
    setSending(true);
    setNotice("");
    const trimmed = message.trim();
    const outcome = submitFeedback(correction
      ? { topic: "content_correction", message: trimmed, ...correction, screen }
      : { topic, message: trimmed, screen });
    setSending(false);
    if (outcome === "sent") {
      setSent(true);
      timer.current = setTimeout(close, 1_100);
    } else if (outcome === "unavailable") {
      setNotice("使用统计未开启或尚未就绪，暂时无法提交反馈。");
    } else {
      setNotice("反馈内容为空，请填写后再提交。");
    }
  }

  return <Modal visible={visible} transparent animationType="none" onRequestClose={close}>
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.root}>
      <Animated.View style={[styles.scrim, { opacity: progress }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="取消反馈" disabled={sending} onPress={close} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <Animated.View style={{ transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [420, 0] }) }] }}>
      <SafeAreaView edges={["bottom"]} style={[styles.panel, { backgroundColor: theme.paper, borderColor: theme.rule }]}>
        <View style={styles.header}>
          <Text style={[styles.heading, { color: theme.ink, fontFamily: theme.serif }]}>{correction ? "内容纠错" : "问题反馈"}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭反馈" disabled={sending} onPress={close}><Text style={{ color: theme.muted }}>取消</Text></Pressable>
        </View>
        {sent ? <View style={styles.sentBlock}><Text accessibilityLiveRegion="polite" style={[styles.sentText, { color: theme.ink, fontFamily: theme.serif }]}>已提交，感谢你的反馈。</Text></View> : <>
          <ScrollView style={styles.body} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" nestedScrollEnabled>
            {correction ? <ScrollView style={[styles.quote, { borderColor: theme.red }]} nestedScrollEnabled><Text selectable style={[styles.quoteText, { color: theme.muted, fontFamily: theme.serif }]}>{correction.quote}</Text></ScrollView> : (
              <View style={styles.topics}>
                {TOPICS.map((option) => {
                  const selected = topic === option.value;
                  return <Pressable key={option.value} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={option.label} onPress={() => setTopic(option.value)} style={[styles.topic, { borderColor: selected ? theme.red : theme.rule, backgroundColor: selected ? theme.red : theme.paper }]}>
                    <Text style={[styles.topicText, { color: selected ? theme.inverse : theme.ink, fontFamily: theme.sans }]}>{option.label}</Text>
                  </Pressable>;
                })}
              </View>
            )}
            <TextInput
              accessibilityLabel={correction ? "问题说明" : "反馈内容"}
              multiline
              maxLength={2000}
              editable={!sending}
              value={message}
              onChangeText={setMessage}
              placeholder={correction ? "说明这里的问题，例如正确的文字……" : "写下你遇到的问题或建议……"}
              placeholderTextColor={theme.muted}
              style={[styles.input, { color: theme.ink, borderColor: theme.rule, fontFamily: theme.serif }]}
            />
            {notice ? <Text accessibilityRole="alert" style={[styles.notice, { color: theme.red, fontFamily: theme.sans }]}>{notice}</Text> : null}
          </ScrollView>
          <View style={styles.footer}>
            <Pressable accessibilityRole="button" accessibilityLabel="提交反馈" disabled={!canSend} onPress={send}
              style={[styles.submit, canSend ? { backgroundColor: theme.red } : { borderWidth: 1, borderColor: theme.rule }]}>
              <Text style={{ color: canSend ? theme.inverse : theme.muted }}>{sending ? "提交中…" : "提交"}</Text>
            </Pressable>
          </View>
        </>}
      </SafeAreaView>
      </Animated.View>
    </KeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" }, scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,.32)" },
  panel: { padding: 20, maxHeight: "88%", minHeight: 0, flexShrink: 1, borderTopWidth: 1 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 18, flexShrink: 0 }, heading: { fontSize: 19 },
  body: { minHeight: 0, flexShrink: 1 },
  quote: { maxHeight: 140, borderLeftWidth: 2, paddingLeft: 12, flexShrink: 1 }, quoteText: { fontSize: 14, lineHeight: 24 },
  topics: { flexDirection: "row", gap: 6, marginBottom: 4 },
  topic: { minHeight: 38, flex: 1, borderWidth: 1, alignItems: "center", justifyContent: "center" }, topicText: { fontSize: 11, fontWeight: "900" },
  input: { minHeight: 96, maxHeight: 220, textAlignVertical: "top", borderBottomWidth: 1, marginVertical: 14, paddingVertical: 10, fontSize: 16, flexShrink: 1 },
  notice: { marginBottom: 10, fontSize: 13 }, sentBlock: { minHeight: 300, alignItems: "center", justifyContent: "center" }, sentText: { fontSize: 15 },
  footer: { flexDirection: "row", justifyContent: "flex-end", flexShrink: 0 }, submit: { paddingVertical: 12, paddingHorizontal: 18 },
});
