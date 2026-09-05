import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { MobileTheme } from "../theme/tokens";

export function BookThoughtComposer({ quote, value, onChange, onCancel, onSave, theme }: {
  quote?: string; value: string; onChange: (value: string) => void; onCancel: () => void; onSave: () => void; theme: MobileTheme;
}) {
  return <Modal visible={quote !== undefined} transparent animationType={theme.eInk ? "none" : "slide"} onRequestClose={onCancel}>
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.root}>
      <Pressable accessibilityRole="button" accessibilityLabel="取消写想法" onPress={onCancel} style={styles.scrim} />
      <SafeAreaView edges={["bottom"]} style={[styles.panel, { backgroundColor: theme.paper, borderColor: theme.rule }]}>
        <View style={styles.header}><Text style={[styles.heading, { color: theme.ink, fontFamily: theme.serif }]}>写想法</Text><Pressable accessibilityRole="button" onPress={onCancel}><Text style={{ color: theme.muted }}>取消</Text></Pressable></View>
        <ScrollView style={[styles.quote, { borderColor: theme.red }]}><Text selectable style={[styles.quoteText, { color: theme.muted, fontFamily: theme.serif }]}>{quote}</Text></ScrollView>
        <TextInput accessibilityLabel="想法内容" autoFocus multiline value={value} onChangeText={onChange} placeholder="写下此刻的想法……" placeholderTextColor={theme.muted} style={[styles.input, { color: theme.ink, borderColor: theme.rule, fontFamily: theme.serif }]} />
        <Pressable accessibilityRole="button" disabled={!value.trim()} onPress={onSave} style={[styles.save, { backgroundColor: theme.red, opacity: value.trim() ? 1 : 0.4 }]}><Text style={{ color: theme.inverse }}>保存想法</Text></Pressable>
      </SafeAreaView>
    </KeyboardAvoidingView>
  </Modal>;
}
const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" }, scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,.32)" },
  panel: { padding: 20, maxHeight: "88%", borderTopWidth: 1 }, header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }, heading: { fontSize: 19 },
  quote: { maxHeight: 140, borderLeftWidth: 2, paddingLeft: 12, flexShrink: 1 }, quoteText: { fontSize: 14, lineHeight: 24 },
  input: { minHeight: 100, maxHeight: 190, textAlignVertical: "top", borderBottomWidth: 1, marginVertical: 18, paddingVertical: 10, fontSize: 16, flexShrink: 1 }, save: { padding: 12, alignSelf: "flex-end" },
});
