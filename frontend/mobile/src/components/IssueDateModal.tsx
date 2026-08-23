import DateTimePicker from "@react-native-community/datetimepicker";
import type { ArchivePublicationSummary } from "@jojo/content";
import { Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { IS_EINK_RELEASE } from "../config/appVariant";
import { mobileTheme } from "../theme/tokens";

interface IssueDateModalProps {
  publication: ArchivePublicationSummary | null;
  value: Date;
  minimumDate: Date;
  maximumDate: Date;
  isDateAvailable: (date: Date) => boolean;
  onChange: (date: Date) => void;
  onClose: () => void;
  onConfirm: () => void;
}

export function IssueDateModal({
  publication,
  value,
  minimumDate,
  maximumDate,
  isDateAvailable,
  onChange,
  onClose,
  onConfirm,
}: IssueDateModalProps) {
  const theme = mobileTheme;
  const available = isDateAvailable(value);
  return (
    <Modal
      visible={Boolean(publication)}
      transparent
      animationType={IS_EINK_RELEASE ? "none" : "fade"}
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="关闭日期选择" />
      <View style={[styles.sheet, { backgroundColor: theme.paper, borderColor: theme.ruleDark }]}>
        <Text style={[styles.eyebrow, { color: theme.red, fontFamily: theme.sans }]}>选择报纸日期</Text>
        <Text style={[styles.title, { color: theme.ink, fontFamily: theme.serif }]}>{publication?.title}</Text>
        <DateTimePicker
          value={value}
          mode="date"
          display={Platform.OS === "ios" ? "inline" : "default"}
          minimumDate={minimumDate}
          maximumDate={maximumDate}
          accentColor={theme.red}
          themeVariant="light"
          onChange={(_, date) => date && onChange(date)}
        />
        {!available ? (
          <Text accessibilityRole="alert" style={[styles.unavailable, { color: theme.red, fontFamily: theme.sans }]}>该日期暂无馆藏，请选择其他日期。</Text>
        ) : null}
        <View style={styles.actions}>
          <Pressable onPress={onClose} style={[styles.secondary, { borderColor: theme.ruleDark }]}>
            <Text style={[styles.secondaryText, { color: theme.ink, fontFamily: theme.sans }]}>取消</Text>
          </Pressable>
          <Pressable
            disabled={!available}
            onPress={onConfirm}
            style={[styles.primary, { backgroundColor: theme.red, opacity: available ? 1 : 0.38 }]}
          >
            <Text style={[styles.primaryText, { color: theme.inverse, fontFamily: theme.sans }]}>打开这一期</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,.36)" },
  sheet: { position: "absolute", left: 16, right: 16, bottom: 20, borderWidth: 1, padding: 18 },
  eyebrow: { fontSize: 10, fontWeight: "900", letterSpacing: 2.2 },
  title: { marginTop: 4, marginBottom: 10, fontSize: 24, fontWeight: "900" },
  actions: { marginTop: 12, flexDirection: "row", gap: 10 },
  unavailable: { marginTop: 8, fontSize: 11, fontWeight: "700" },
  primary: { height: 46, flex: 1.5, alignItems: "center", justifyContent: "center" },
  primaryText: { fontSize: 13, fontWeight: "900" },
  secondary: { height: 46, flex: 1, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  secondaryText: { fontSize: 13, fontWeight: "800" },
});
