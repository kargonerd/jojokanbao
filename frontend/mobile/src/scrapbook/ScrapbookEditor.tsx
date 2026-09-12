import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { ScrapbookDraft } from "@jojo/auth";
import { mobileTheme as theme } from "../theme/tokens";

export function ScrapbookEditor({ initial, saving, error, onSave, onClose }: {
  initial: ScrapbookDraft; saving: boolean; error: string;
  onSave: (value: ScrapbookDraft) => void; onClose: () => void;
}) {
  const [quote, setQuote] = useState(initial.quote);
  const [note, setNote] = useState(initial.note);
  const [collection, setCollection] = useState(initial.collection);
  return <Modal visible transparent animationType="none" onRequestClose={() => { if (!saving) onClose(); }}>
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <SafeAreaView style={styles.panel} edges={["bottom", "top"]}>
        <View style={styles.header}><Text style={styles.heading}>保存剪报</Text><Pressable accessibilityRole="button" onPress={onClose} disabled={saving}><Text style={styles.link}>取消</Text></Pressable></View>
        <ScrollView keyboardShouldPersistTaps="handled">
          <Text style={styles.source}>{initial.contentTitle}　{initial.locationLabel}</Text>
          <Text style={styles.label}>原文摘录</Text><TextInput accessibilityLabel="原文摘录" multiline value={quote} onChangeText={setQuote} maxLength={6000} editable={!saving} style={styles.input} placeholder="摘录原文，也可以只写笔记" placeholderTextColor={theme.muted} />
          <Text style={styles.label}>我的笔记</Text><TextInput accessibilityLabel="我的笔记" multiline value={note} onChangeText={setNote} maxLength={8000} editable={!saving} style={styles.input} placeholder="这条材料值得记下什么？" placeholderTextColor={theme.muted} />
          <Text style={styles.label}>专题</Text><TextInput accessibilityLabel="专题" value={collection} onChangeText={setCollection} maxLength={80} editable={!saving} style={[styles.input, styles.single]} placeholder="留空则不分类，也可输入新专题" placeholderTextColor={theme.muted} />
          <Text style={styles.source}>仅自己可见，保存后可在其他设备的剪报本中查看。</Text>
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <Pressable accessibilityRole="button" disabled={saving || (!quote.trim() && !note.trim())} onPress={() => onSave({ ...initial, quote, note, collection })} style={[styles.save, (saving || (!quote.trim() && !note.trim())) && { opacity: .5 }]}><Text style={styles.saveText}>{saving ? "保存中…" : "保存到剪报本"}</Text></Pressable>
        </ScrollView>
      </SafeAreaView>
    </KeyboardAvoidingView>
  </Modal>;
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "rgba(0,0,0,.35)", justifyContent: "flex-end" },
  panel: { maxHeight: "94%", backgroundColor: theme.paper, padding: 20, borderTopWidth: 3, borderColor: theme.red },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  heading: { color: theme.ink, fontFamily: theme.serif, fontSize: 22 }, link: { color: theme.red, padding: 8 },
  source: { color: theme.muted, lineHeight: 22, fontSize: 13, marginBottom: 16 },
  label: { color: theme.ink, fontFamily: theme.serif, fontSize: 15, marginBottom: 6 },
  input: { color: theme.ink, fontSize: 16, lineHeight: 26, minHeight: 100, borderWidth: 1, borderColor: theme.ruleDark, padding: 10, marginBottom: 18, textAlignVertical: "top" },
  single: { minHeight: 46 }, error: { color: theme.red, lineHeight: 24, marginBottom: 12 },
  save: { backgroundColor: theme.red, padding: 14, alignItems: "center", marginBottom: 12 }, saveText: { color: theme.paper, fontSize: 15, fontFamily: theme.serif },
});
