import { submitFeedback, type FeedbackTopic } from "@jojo/analytics/feedback";
import { useNavigation, useRoute, type NavigationProp, type RouteProp } from "@react-navigation/native";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ScreenHeader } from "../components/ScreenHeader";
import type { FeedbackCorrection, RootStackParamList } from "../navigation/types";
import { mobileTheme } from "../theme/tokens";

const TOPICS: Array<{ value: Exclude<FeedbackTopic, "content_correction">; label: string }> = [
  { value: "bug", label: "功能异常" },
  { value: "suggestion", label: "功能建议" },
  { value: "other", label: "其他" },
];

const MESSAGE_MAX_LENGTH = 2_000;

/** Full-page feedback form: a correction quoting selected text, or a free
 * problem report and suggestion from settings. */
export function FeedbackScreen() {
  const route = useRoute<RouteProp<RootStackParamList, "Feedback">>();
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const correction = route.params?.correction;
  const screen = route.params?.screen;
  const theme = mobileTheme;

  const [topic, setTopic] = useState<Exclude<FeedbackTopic, "content_correction">>("bug");
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const canSend = Boolean(message.trim()) && !sending && !sent;

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
      setTimeout(() => navigation.goBack(), 1_100);
    } else if (outcome === "unavailable") {
      setNotice("使用统计未开启或尚未就绪，暂时无法提交反馈。");
    } else {
      setNotice("反馈内容为空，请填写后再提交。");
    }
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.canvas }]}>
      <ScreenHeader title={correction ? "内容纠错" : "问题反馈"} onBack={() => navigation.goBack()} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} bounces={!theme.eInk} overScrollMode={theme.eInk ? "never" : "auto"} keyboardShouldPersistTaps="handled">
          {sent ? (
            <View style={[styles.sentBlock, { borderColor: theme.rule, backgroundColor: theme.paper }]}>
              <Text accessibilityLiveRegion="polite" style={[styles.sentText, { color: theme.ink, fontFamily: theme.serif }]}>已提交，感谢你的反馈。</Text>
            </View>
          ) : (
            <>
              {correction ? (
                <View style={[styles.quote, { borderLeftColor: theme.red }]}>
                  <Text style={[styles.quoteLabel, { color: theme.muted, fontFamily: theme.sans }]}>选中内容</Text>
                  <Text selectable style={[styles.quoteText, { color: theme.ink, fontFamily: theme.serif }]}>{correction.quote}</Text>
                  {correction.contentTitle ? <Text style={[styles.quoteSource, { color: theme.muted, fontFamily: theme.sans }]}>——《{correction.contentTitle}》{correction.section ? ` · ${correction.section}` : ""}</Text> : null}
                </View>
              ) : (
                <View style={styles.topics}>
                  {TOPICS.map((option) => {
                    const selected = topic === option.value;
                    return <Pressable key={option.value} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={option.label} onPress={() => setTopic(option.value)}
                      style={[styles.topic, { borderColor: selected ? theme.red : theme.rule, backgroundColor: selected ? theme.red : theme.paper }]}>
                      <Text style={[styles.topicText, { color: selected ? theme.inverse : theme.ink, fontFamily: theme.sans }]}>{option.label}</Text>
                    </Pressable>;
                  })}
                </View>
              )}
              <TextInput
                accessibilityLabel={correction ? "问题说明" : "反馈内容"}
                multiline
                maxLength={MESSAGE_MAX_LENGTH}
                editable={!sending}
                value={message}
                onChangeText={setMessage}
                placeholder={correction ? "说明这里的问题，例如正确的文字……" : "写下你遇到的问题或建议……"}
                placeholderTextColor={theme.muted}
                style={[styles.input, { color: theme.ink, borderColor: theme.rule, backgroundColor: theme.paper, fontFamily: theme.serif }]}
              />
              <Text style={[styles.counter, { color: theme.muted, fontFamily: theme.sans }]}>{message.length}/{MESSAGE_MAX_LENGTH}</Text>
              {notice ? <Text accessibilityRole="alert" style={[styles.notice, { color: theme.red, fontFamily: theme.sans }]}>{notice}</Text> : null}
              <Pressable accessibilityRole="button" accessibilityLabel="提交反馈" disabled={!canSend} onPress={send}
                style={[styles.submit, canSend ? { backgroundColor: theme.red } : { borderWidth: 1, borderColor: theme.rule }]}>
                <Text style={[styles.submitText, { color: canSend ? theme.inverse : theme.muted, fontFamily: theme.sans }]}>{sending ? "提交中…" : "提交反馈"}</Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  content: { padding: 20, paddingBottom: 40 },
  topics: { flexDirection: "row", gap: 8, marginBottom: 16 },
  topic: { minHeight: 40, flex: 1, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  topicText: { fontSize: 13, fontWeight: "700" },
  quote: { borderLeftWidth: 3, paddingLeft: 14, paddingVertical: 4, marginBottom: 18 },
  quoteLabel: { fontSize: 12, marginBottom: 6 },
  quoteText: { fontSize: 15, lineHeight: 26 },
  quoteSource: { fontSize: 12, marginTop: 8 },
  input: { minHeight: 220, textAlignVertical: "top", borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, lineHeight: 26 },
  counter: { alignSelf: "flex-end", marginTop: 6, fontSize: 12 },
  notice: { marginTop: 10, fontSize: 13 },
  submit: { marginTop: 18, minHeight: 48, alignItems: "center", justifyContent: "center" },
  submitText: { fontSize: 15, fontWeight: "700" },
  sentBlock: { borderWidth: 1, paddingVertical: 28, alignItems: "center", marginTop: 24 },
  sentText: { fontSize: 16 },
});
