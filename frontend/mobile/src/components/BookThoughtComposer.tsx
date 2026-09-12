import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { MobileTheme } from "../theme/tokens";
import type { AnnotationVisibility } from "@jojo/content/annotations";
import { CommentVisibilityControl } from "../annotations/CommentVisibilityControl";

export function BookThoughtComposer({ quote, value, visibility, saving, error, localOnly, onChange, onVisibilityChange, onCancel, onSave, onSaveLocal, theme }: {
  quote?: string; value: string; visibility: AnnotationVisibility; saving: boolean; error: string; localOnly?: boolean;
  onChange: (value: string) => void; onVisibilityChange: (value: AnnotationVisibility) => void;
  onCancel: () => void; onSave: () => void; onSaveLocal?: () => void; theme: MobileTheme;
}) {
  const canSave = Boolean(value.trim()) && value.length <= 2000 && !saving;
  const close = () => { if (!saving) onCancel(); };
  return <Modal visible={quote !== undefined} transparent animationType={theme.eInk ? "none" : "slide"} onRequestClose={close}>
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.root}>
      <Pressable accessibilityRole="button" accessibilityLabel="取消写想法" disabled={saving} onPress={close} style={styles.scrim} />
      <SafeAreaView edges={["bottom"]} style={[styles.panel, { backgroundColor: theme.paper, borderColor: theme.rule }]}>
        <View style={styles.header}><Text style={[styles.heading, { color: theme.ink, fontFamily: theme.serif }]}>写想法</Text><Pressable accessibilityRole="button" disabled={saving} onPress={close}><Text style={{ color: theme.muted }}>取消</Text></Pressable></View>
        <ScrollView testID="thought-editor-scroll" style={styles.editor} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" nestedScrollEnabled>
        <ScrollView style={[styles.quote, { borderColor: theme.red }]} nestedScrollEnabled><Text selectable style={[styles.quoteText, { color: theme.muted, fontFamily: theme.serif }]}>{quote}</Text></ScrollView>
        <TextInput accessibilityLabel="想法内容" autoFocus multiline maxLength={2000} editable={!saving} value={value} onChangeText={onChange} placeholder="写下此刻的想法……" placeholderTextColor={theme.muted} style={[styles.input, { color: theme.ink, borderColor: theme.rule, fontFamily: theme.serif }]} />
        {error ? <View><Text accessibilityRole="alert" style={[styles.error, { color: theme.red }]}>{error}</Text>{!localOnly && onSaveLocal ? <Pressable accessibilityRole="button" accessibilityLabel="先保存到本机" disabled={!canSave} onPress={onSaveLocal} style={[styles.localSave, { opacity: canSave ? 1 : .45 }]}><Text style={{ color: theme.red, fontFamily: theme.sans }}>先保存到本机</Text></Pressable> : null}</View> : null}
        </ScrollView>
        <View style={styles.footer}>
          {localOnly ? <Text style={{ color: theme.muted }}>仅保存在本机</Text> : <CommentVisibilityControl value={visibility} onChange={onVisibilityChange} disabled={saving} theme={theme} />}
          <Pressable accessibilityRole="button" accessibilityLabel="保存想法" disabled={!canSave} onPress={onSave} style={[styles.save, { backgroundColor: theme.red, opacity: canSave ? 1 : 0.4 }]}><Text style={{ color: theme.inverse }}>{saving ? "保存中…" : "保存"}</Text></Pressable>
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  </Modal>;
}
const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" }, scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,.32)" },
  panel: { padding: 20, maxHeight: "88%", minHeight: 0, flexShrink: 1, borderTopWidth: 1 }, header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 18, flexShrink: 0 }, heading: { fontSize: 19 },
  editor: { minHeight: 0, flexShrink: 1 },
  quote: { maxHeight: 140, borderLeftWidth: 2, paddingLeft: 12, flexShrink: 1 }, quoteText: { fontSize: 14, lineHeight: 24 },
  input: { minHeight: 70, maxHeight: 190, textAlignVertical: "top", borderBottomWidth: 1, marginVertical: 14, paddingVertical: 10, fontSize: 16, flexShrink: 1 },
  footer: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, flexShrink: 0 },
  localSave: { minHeight: 40, justifyContent: "center", alignSelf: "flex-start", marginBottom: 8 },
  error: { marginBottom: 10, fontSize: 13 }, save: { paddingVertical: 12, paddingHorizontal: 18, marginLeft: "auto" },
});
