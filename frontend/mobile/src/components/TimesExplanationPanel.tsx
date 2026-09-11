import Ionicons from "@expo/vector-icons/Ionicons";
import { useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MAX_EXPLANATION_QUESTION_LENGTH, type ExplanationConversation } from "@jojo/ui/reader-explanation";
import type { MobileTimesExplanationMetadata, MobileTimesTextAnchor } from "../lib/timesAgent";
import { IS_EINK_RELEASE } from "../config/appVariant";
import { mobileTheme as theme } from "../theme/tokens";

type Props = ExplanationConversation<MobileTimesTextAnchor, MobileTimesExplanationMetadata> & {
  onClose(): void;
  onRetry(): void;
  onAsk(question: string): boolean;
  onStop(): void;
};

export function TimesExplanationPanel({ anchor, turns, onClose, onRetry, onAsk, onStop }: Props) {
  const [draft, setDraft] = useState("");
  const scroll = useRef<ScrollView>(null);
  const followAnswer = useRef(true);
  const busy = turns.at(-1)?.phase === "pending";
  const metadata = [...turns].reverse().find((turn) => turn.metadata)?.metadata;
  function submit() {
    if (!busy && onAsk(draft)) { setDraft(""); followAnswer.current = true; }
  }
  return <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.root}>
    <Pressable accessibilityRole="button" accessibilityLabel="关闭 AI 解释" onPress={onClose} style={StyleSheet.absoluteFillObject} />
    <SafeAreaView edges={["top", "bottom"]} style={styles.panel} accessibilityViewIsModal>
      <View style={styles.header}>
        <View style={styles.headingRule}><Text style={styles.title}>AI 解释</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose} hitSlop={8}><Ionicons name="close" size={24} color={theme.red} /></Pressable>
      </View>
      <ScrollView ref={scroll} style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
        overScrollMode={IS_EINK_RELEASE ? "never" : "always"} scrollEventThrottle={100}
        onScroll={({ nativeEvent: event }) => { followAnswer.current = event.contentSize.height - event.contentOffset.y - event.layoutMeasurement.height < 80; }}
        onContentSizeChange={() => { if (followAnswer.current) scroll.current?.scrollToEnd({ animated: false }); }}>
        <View style={styles.quoteBox}><Text selectable style={styles.quote}>{anchor.quote}</Text></View>
        {turns.map((turn, index) => <View key={index} style={index ? styles.followup : undefined}>
          {turn.question ? <View style={styles.questionBox}><Text style={styles.questionLabel}>你</Text><Text selectable style={styles.question}>{turn.question}</Text></View> : null}
          {turn.answer ? <Text selectable style={styles.answer}>{turn.answer.replace(/<!--[^]*$/u, "").trim()}</Text> : null}
          {turn.phase === "pending" ? <View accessibilityRole="progressbar" accessibilityLabel={turn.status} style={styles.progress}>
            {!IS_EINK_RELEASE ? <ActivityIndicator color={theme.red} /> : null}<Text style={styles.status}>{turn.status}</Text>
          </View> : null}
          {turn.error ? <Text accessibilityRole="alert" style={styles.error}>{turn.error}</Text> : null}
          {turn.phase === "stopped" ? <Text style={styles.stopped}>已停止生成</Text> : null}
          {index === turns.length - 1 && ["error", "stopped"].includes(turn.phase) ? <Pressable accessibilityRole="button" onPress={onRetry}><Text style={styles.retry}>{turn.question ? "重试回答" : "重新解释"}</Text></Pressable> : null}
        </View>)}
      </ScrollView>
      <View style={styles.composer}>
        <TextInput accessibilityLabel="继续提问" value={draft} onChangeText={setDraft} placeholder="继续提问…" placeholderTextColor={theme.muted}
          multiline maxLength={MAX_EXPLANATION_QUESTION_LENGTH} style={styles.input} />
        <View style={styles.composerActions}>
          <Text numberOfLines={1} style={styles.meta}>{metadata?.model || ""}</Text>
          {busy ? <Pressable accessibilityRole="button" onPress={onStop} style={styles.stop}><Text style={styles.stopText}>停止生成</Text></Pressable>
            : <Pressable accessibilityRole="button" accessibilityLabel="发送追问" accessibilityState={{ disabled: !draft.trim() }} disabled={!draft.trim()} onPress={submit} style={[styles.send, !draft.trim() && styles.disabled]}><Text style={styles.sendText}>发送 →</Text></Pressable>}
        </View>
      </View>
    </SafeAreaView>
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "flex-end", backgroundColor: "rgba(0,0,0,.24)" },
  panel: { width: "100%", maxWidth: 460, flex: 1, borderLeftWidth: 1, backgroundColor: theme.paper, borderColor: theme.ruleDark },
  header: { height: 64, borderBottomWidth: 1, borderBottomColor: theme.ruleDark, paddingHorizontal: 18, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headingRule: { borderLeftWidth: 3, paddingLeft: 12, borderLeftColor: theme.red },
  title: { fontSize: 23, fontWeight: "900", color: theme.red, fontFamily: theme.serif },
  scroll: { flex: 1 },
  content: { padding: 20, paddingBottom: 28 },
  quoteBox: { borderLeftWidth: 2, paddingLeft: 13, borderLeftColor: theme.ruleDark, marginBottom: 20 },
  quote: { fontSize: 12, lineHeight: 21, color: theme.muted, fontFamily: theme.serif },
  followup: { marginTop: 24, paddingTop: 24, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.rule },
  questionBox: { padding: 12, marginBottom: 16, borderLeftWidth: 2, borderLeftColor: theme.red, backgroundColor: "rgba(139,26,26,.035)" },
  questionLabel: { color: theme.red, fontFamily: theme.sans, fontSize: 10, fontWeight: "900", marginBottom: 4 },
  question: { color: theme.ink, fontFamily: theme.serif, fontSize: 14, lineHeight: 24 },
  answer: { fontSize: 16, lineHeight: 29, color: theme.ink, fontFamily: theme.serif },
  progress: { marginTop: 20, flexDirection: "row", alignItems: "center", gap: 10 },
  status: { flex: 1, fontSize: 10, lineHeight: 18, fontWeight: "900", color: theme.red, fontFamily: theme.sans },
  error: { marginTop: 20, fontSize: 12, lineHeight: 21, fontWeight: "700", color: theme.red, fontFamily: theme.sans },
  retry: { marginTop: 16, fontSize: 11, fontWeight: "900", color: theme.red, fontFamily: theme.sans },
  stopped: { marginTop: 12, fontSize: 11, color: theme.muted, fontFamily: theme.sans },
  composer: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.rule },
  input: { minHeight: 64, maxHeight: 128, paddingVertical: 8, paddingHorizontal: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.ruleDark, fontSize: 14, lineHeight: 24, color: theme.ink, fontFamily: theme.serif, textAlignVertical: "top" },
  composerActions: { marginTop: 10, flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  meta: { flex: 1, fontSize: 9, color: theme.muted, fontFamily: theme.sans },
  send: { minHeight: 40, justifyContent: "center", paddingHorizontal: 16, backgroundColor: theme.red, borderWidth: 1, borderColor: theme.red },
  sendText: { fontSize: 12, fontWeight: "900", color: theme.paper, fontFamily: theme.sans },
  stop: { minHeight: 40, justifyContent: "center", paddingHorizontal: 16, borderWidth: 1, borderColor: theme.red },
  stopText: { fontSize: 12, fontWeight: "900", color: theme.red, fontFamily: theme.sans },
  disabled: { opacity: 0.35 },
});
