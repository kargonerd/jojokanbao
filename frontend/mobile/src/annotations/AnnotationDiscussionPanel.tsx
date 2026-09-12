import Ionicons from "@expo/vector-icons/Ionicons";
import { ANNOTATION_REPORT_LABELS, type AnnotationReportReason, type AnnotationThread, type AnnotationVisibility } from "@jojo/content";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { MobileTheme } from "../theme/tokens";
import { CommentVisibilityControl } from "./CommentVisibilityControl";

export interface AnnotationDiscussionPanelProps {
  thread: AnnotationThread;
  currentUserId: string;
  onClose: () => void;
  onComment: (body: string, parentCommentId?: string, visibility?: AnnotationVisibility) => Promise<unknown>;
  onReport: (commentId: string, reason: AnnotationReportReason, details?: string) => Promise<unknown>;
  theme: MobileTheme;
}

export function AnnotationDiscussionPanel(props: AnnotationDiscussionPanelProps) {
  return <DiscussionContent key={`${props.thread.id}:${props.currentUserId}`} {...props} />;
}

function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date)
    : "";
}

function DiscussionContent({ thread, currentUserId, onClose, onComment, onReport, theme }: AnnotationDiscussionPanelProps) {
  const [draft, setDraft] = useState("");
  const [visibility, setVisibility] = useState<AnnotationVisibility>("public");
  const [replyTo, setReplyTo] = useState<string>();
  const [reporting, setReporting] = useState<string>();
  const [reportReason, setReportReason] = useState<AnnotationReportReason>("spam");
  const [reportDetails, setReportDetails] = useState("");
  const [reported, setReported] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ kind: "comment" } | { kind: "report"; commentId: string }>();
  const [notice, setNotice] = useState("");
  const [compact, setCompact] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // The API already enforces visibility; keep an account change from briefly
  // rendering another reader's cached private comment.
  const comments = thread.comments.filter((comment) => comment.visibility !== "private" || comment.authorId === currentUserId);
  const reply = comments.find((comment) => comment.id === replyTo && comment.visibility !== "private");
  const underlineCount = Number.isFinite(thread.underlineCount) ? Math.max(1, Math.trunc(thread.underlineCount!)) : 1;

  async function submitComment() {
    const body = draft.trim();
    if (!body || busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setFailure(undefined); setNotice("");
    try {
      await onComment(body, reply?.id, visibility);
      if (!mounted.current) return;
      setDraft(""); setReplyTo(undefined); setVisibility("public");
      setNotice("想法已保存");
    } catch {
      if (mounted.current) setFailure({ kind: "comment" });
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function submitReport(commentId: string) {
    const comment = comments.find((entry) => entry.id === commentId);
    if (!comment || comment.visibility === "private" || comment.authorId === currentUserId || comment.reportedByMe || reported.has(comment.id) || busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setFailure(undefined); setNotice("");
    try {
      await onReport(commentId, reportReason, reportDetails.trim() || undefined);
      if (!mounted.current) return;
      setReported((current) => new Set([...current, commentId]));
      setReporting(undefined); setReportDetails("");
      setNotice("举报已提交");
    } catch {
      if (mounted.current) setFailure({ kind: "report", commentId });
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function close() { if (!busyRef.current) onClose(); }
  function startReply(commentId: string) {
    setReplyTo(commentId); setReporting(undefined); setFailure(undefined); setNotice("");
  }
  function startReport(commentId: string) {
    setReporting(commentId); setReplyTo(undefined); setReportReason("spam"); setReportDetails(""); setFailure(undefined); setNotice("");
  }

  return <Modal visible transparent animationType={theme.eInk ? "none" : "slide"} onRequestClose={close}>
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.root}>
      <Pressable accessibilityRole="button" accessibilityLabel="关闭划线详情背景" disabled={busy} onPress={close} style={styles.scrim} />
      <SafeAreaView accessibilityViewIsModal edges={["bottom"]} onLayout={(event) => setCompact(event.nativeEvent.layout.height < 300)} style={[styles.panel, { backgroundColor: theme.paper, borderTopColor: theme.rule }]}>
        <View style={[styles.header, compact && styles.compactHeader, { borderBottomColor: theme.rule }]}>
          <View style={styles.headerCopy}>{!compact ? <Text numberOfLines={1} style={[styles.bookTitle, { color: theme.muted, fontFamily: theme.sans }]}>{thread.contentTitle}</Text> : null}<Text accessibilityRole="header" style={[styles.heading, { color: theme.ink, fontFamily: theme.serif }]}>划线详情</Text></View>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭划线详情" disabled={busy} onPress={close} style={styles.close}><Ionicons name="close" size={23} color={theme.muted} /></Pressable>
        </View>
        <ScrollView style={styles.history} contentContainerStyle={styles.historyContent} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
          <View style={[styles.quote, { borderLeftColor: theme.red }]}><Text accessibilityLabel="划线原文" selectable style={[styles.quoteText, { color: theme.ink, fontFamily: theme.serif }]}>{thread.quote}</Text></View>
          <Text style={[styles.meta, { color: theme.red, fontFamily: theme.sans }]}>{underlineCount} 人划线</Text>
          <View style={[styles.commentsHeading, { borderBottomColor: theme.rule }]}><Text style={[styles.commentsTitle, { color: theme.ink, fontFamily: theme.serif }]}>想法</Text><Text style={{ color: theme.muted, fontFamily: theme.sans }}>{comments.length}</Text></View>
          {!comments.length ? <Text style={[styles.empty, { color: theme.muted, fontFamily: theme.sans }]}>还没有想法。</Text> : null}
          {comments.map((comment) => {
            const parent = comments.find((entry) => entry.id === comment.parentCommentId);
            const alreadyReported = comment.reportedByMe || reported.has(comment.id);
            return <View key={comment.id} testID={`annotation-comment-${comment.id}`} style={[styles.comment, { borderBottomColor: theme.rule }]}>
              <View style={styles.byline}><Text style={[styles.author, { color: theme.ink, fontFamily: theme.sans }]}>{comment.authorName}</Text><Text style={[styles.time, { color: theme.muted, fontFamily: theme.sans }]}>{displayTime(comment.createdAt)}</Text></View>
              {comment.visibility === "private" ? <View style={styles.private}><Ionicons name="lock-closed-outline" size={12} color={theme.muted} /><Text style={[styles.small, { color: theme.muted, fontFamily: theme.sans }]}>仅自己可见</Text></View> : null}
              {parent ? <Text style={[styles.parent, { color: theme.muted, fontFamily: theme.sans }]}>回复 {parent.authorName}</Text> : null}
              <Text selectable style={[styles.body, { color: theme.ink, fontFamily: theme.serif }]}>{comment.body}</Text>
              {comment.visibility !== "private" ? <View style={styles.actions}>
                <Pressable accessibilityRole="button" accessibilityLabel={`回复${comment.authorName}的想法`} disabled={busy} onPress={() => startReply(comment.id)} style={styles.action}><Text style={[styles.small, { color: theme.red, fontFamily: theme.sans }]}>回复</Text></Pressable>
                {comment.authorId !== currentUserId ? <Pressable accessibilityRole="button" accessibilityLabel={alreadyReported ? "已举报" : `举报${comment.authorName}的想法`} accessibilityState={{ disabled: busy || alreadyReported }} disabled={busy || alreadyReported} onPress={() => startReport(comment.id)} style={styles.action}><Text style={[styles.small, { color: theme.muted, fontFamily: theme.sans }]}>{alreadyReported ? "已举报" : "举报"}</Text></Pressable> : null}
              </View> : null}
              {reporting === comment.id && comment.visibility !== "private" && comment.authorId !== currentUserId ? <View style={[styles.report, { backgroundColor: theme.paperSoft, borderColor: theme.rule }]}>
                <Text style={[styles.reportHeading, { color: theme.ink, fontFamily: theme.sans }]}>举报原因</Text>
                <View accessibilityRole="radiogroup" accessibilityLabel="举报原因" style={styles.reasons}>{Object.entries(ANNOTATION_REPORT_LABELS).map(([reason, label]) => <Pressable key={reason} accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ checked: reportReason === reason, disabled: busy }} disabled={busy} onPress={() => setReportReason(reason as AnnotationReportReason)} style={[styles.reason, { borderColor: reportReason === reason ? theme.red : theme.rule }]}><Text style={[styles.small, { color: reportReason === reason ? theme.red : theme.ink, fontFamily: theme.sans }]}>{label}</Text></Pressable>)}</View>
                <TextInput accessibilityLabel="举报补充说明" multiline maxLength={1000} value={reportDetails} onChangeText={(value) => setReportDetails(value.slice(0, 1000))} editable={!busy} placeholder="补充说明（选填）" placeholderTextColor={theme.muted} style={[styles.reportInput, { borderColor: theme.rule, color: theme.ink, fontFamily: theme.serif }]} />
                <View style={styles.reportActions}><Pressable accessibilityRole="button" accessibilityLabel="取消举报" disabled={busy} onPress={() => { setReporting(undefined); setFailure(undefined); }} style={styles.action}><Text style={{ color: theme.muted }}>取消</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="提交举报" disabled={busy} onPress={() => void submitReport(comment.id)} style={styles.action}><Text style={{ color: theme.red }}>{busy ? "提交中…" : "提交举报"}</Text></Pressable></View>
              </View> : null}
            </View>;
          })}
        </ScrollView>
        <View style={[styles.composer, compact && styles.compactComposer, { borderTopColor: theme.rule }]}>
          <ScrollView testID="discussion-editor-scroll" style={styles.editor} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" nestedScrollEnabled>
          {reply ? <View style={styles.reply}><Text numberOfLines={1} style={[styles.replyText, { color: theme.muted, fontFamily: theme.sans }]}>回复 {reply.authorName}</Text><Pressable accessibilityRole="button" accessibilityLabel="取消回复" disabled={busy} onPress={() => setReplyTo(undefined)} style={styles.action}><Text style={{ color: theme.muted }}>取消</Text></Pressable></View> : null}
          <TextInput accessibilityLabel="讨论想法内容" multiline maxLength={2000} editable={!busy} value={draft} onChangeText={(value) => setDraft(value.slice(0, 2000))} placeholder={reply ? `回复 ${reply.authorName}……` : "写下你的想法……"} placeholderTextColor={theme.muted} style={[styles.input, { color: theme.ink, borderBottomColor: theme.rule, fontFamily: theme.serif }]} />
          {failure ? <View style={styles.feedback}><Text accessibilityRole="alert" style={[styles.failure, { color: theme.red, fontFamily: theme.sans }]}>{failure.kind === "comment" ? "想法暂未保存，请重试。" : "举报暂未提交，请重试。"}</Text><Pressable accessibilityRole="button" accessibilityLabel="重试" disabled={busy} onPress={() => void (failure.kind === "comment" ? submitComment() : submitReport(failure.commentId))} style={styles.action}><Text style={{ color: theme.red }}>重试</Text></Pressable></View> : notice ? <Text accessibilityLiveRegion="polite" style={[styles.notice, { color: theme.muted, fontFamily: theme.sans }]}>{notice}</Text> : null}
          </ScrollView>
          <View style={[styles.composerActions, compact && styles.compactActions]}><CommentVisibilityControl value={visibility} onChange={setVisibility} disabled={busy} theme={theme} /><Pressable accessibilityRole="button" accessibilityLabel="发表想法" disabled={busy || !draft.trim()} onPress={() => void submitComment()} style={[styles.save, { backgroundColor: theme.red, opacity: busy || !draft.trim() ? .45 : 1 }]}><Text style={[styles.saveText, { color: theme.inverse, fontFamily: theme.sans }]}>{busy ? "保存中…" : "发表想法"}</Text></Pressable></View>
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" }, scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,.32)" },
  panel: { height: "90%", maxHeight: "90%", minHeight: 0, borderTopWidth: 1 }, header: { paddingHorizontal: 20, paddingVertical: 16, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, flexShrink: 0 },
  compactHeader: { paddingVertical: 4 }, compactComposer: { paddingTop: 4, paddingBottom: 4 }, compactActions: { paddingTop: 4 },
  headerCopy: { flex: 1 }, bookTitle: { fontSize: 11, marginBottom: 5 }, heading: { fontSize: 20, fontWeight: "700" }, close: { width: 42, height: 42, alignItems: "center", justifyContent: "center" },
  history: { flex: 1, minHeight: 0 }, historyContent: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12 }, quote: { borderLeftWidth: 2, paddingLeft: 14 }, quoteText: { fontSize: 16, lineHeight: 28 }, meta: { marginTop: 14, fontSize: 12, fontWeight: "700" },
  commentsHeading: { marginTop: 25, paddingBottom: 12, borderBottomWidth: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, commentsTitle: { fontSize: 17, fontWeight: "700" }, empty: { paddingVertical: 26, fontSize: 13 },
  comment: { paddingTop: 18, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth }, byline: { flexDirection: "row", gap: 12, alignItems: "baseline" }, author: { fontSize: 12, fontWeight: "700", flex: 1 }, time: { fontSize: 10 }, private: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 7 },
  small: { fontSize: 12, lineHeight: 18 }, parent: { marginTop: 8, fontSize: 11 }, body: { fontSize: 15, lineHeight: 25, marginTop: 10 }, actions: { flexDirection: "row", gap: 24 }, action: { minHeight: 40, justifyContent: "center", paddingHorizontal: 3 },
  report: { borderWidth: 1, padding: 12, marginBottom: 6 }, reportHeading: { fontSize: 12, fontWeight: "700", marginBottom: 10 }, reasons: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, reason: { borderWidth: 1, paddingVertical: 8, paddingHorizontal: 10 },
  reportInput: { minHeight: 70, fontSize: 14, lineHeight: 22, borderBottomWidth: 1, marginTop: 12, paddingVertical: 8, textAlignVertical: "top" }, reportActions: { flexDirection: "row", justifyContent: "flex-end", gap: 20 },
  composer: { paddingHorizontal: 20, paddingTop: 9, paddingBottom: 10, borderTopWidth: 1, minHeight: 0, flexShrink: 1, maxHeight: "65%" }, editor: { minHeight: 0, flexShrink: 1 }, reply: { flexDirection: "row", alignItems: "center", gap: 12 }, replyText: { fontSize: 12, flex: 1 },
  input: { minHeight: 64, maxHeight: 132, fontSize: 15, lineHeight: 24, textAlignVertical: "top", paddingVertical: 10, borderBottomWidth: 1 }, composerActions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 10, paddingTop: 10, flexShrink: 0 },
  save: { minHeight: 40, justifyContent: "center", paddingHorizontal: 14 }, saveText: { fontSize: 12, fontWeight: "700" }, feedback: { flexDirection: "row", alignItems: "center", gap: 12 }, failure: { flex: 1, fontSize: 12, lineHeight: 18 }, notice: { marginTop: 8, fontSize: 12, lineHeight: 18 },
});
