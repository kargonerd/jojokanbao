import Ionicons from "@expo/vector-icons/Ionicons";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { useState, type ReactNode } from "react";
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMobileAuthStore } from "../account/auth";
import { ScreenHeader } from "../components/ScreenHeader";
import type { RootStackParamList } from "../navigation/types";
import { mobileTheme } from "../theme/tokens";

type AccountSheet = "password" | "delete" | null;

function Field({
  label,
  value,
  onChangeText,
  secure = false,
  autoFocus = false,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  secure?: boolean;
  autoFocus?: boolean;
}) {
  const theme = mobileTheme;
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.ink, fontFamily: theme.sans }]}>{label}</Text>
      <TextInput
        autoFocus={autoFocus}
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={secure}
        autoCapitalize="none"
        style={[styles.input, { color: theme.ink, borderColor: theme.ruleDark, backgroundColor: theme.paper, fontFamily: theme.sans }]}
      />
    </View>
  );
}

function Action({
  label,
  onPress,
  disabled,
  outline = false,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  outline?: boolean;
}) {
  const theme = mobileTheme;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        { borderColor: theme.red, backgroundColor: outline ? theme.paper : theme.red, opacity: disabled ? 0.45 : pressed ? 0.75 : 1 },
      ]}
    >
      <Text style={[styles.actionText, { color: outline ? theme.red : theme.inverse, fontFamily: theme.sans }]}>{label}</Text>
    </Pressable>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  const theme = mobileTheme;
  return (
    <View style={[styles.infoRow, { borderTopColor: theme.rule }]}>
      <Text style={[styles.infoLabel, { color: theme.muted, fontFamily: theme.sans }]}>{label}</Text>
      <Text selectable style={[styles.infoValue, { color: theme.ink, fontFamily: theme.serif }]}>{value}</Text>
    </View>
  );
}

function SettingsRow({
  title,
  description,
  onPress,
  disabled,
  danger = false,
}: {
  title: string;
  description: string;
  onPress: () => void;
  disabled: boolean;
  danger?: boolean;
}) {
  const theme = mobileTheme;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.settingsRow,
        { borderTopColor: danger ? theme.red : theme.rule, opacity: disabled ? 0.45 : pressed ? 0.65 : 1 },
      ]}
    >
      <View style={styles.settingsCopy}>
        <Text style={[styles.settingsTitle, { color: danger ? theme.red : theme.ink, fontFamily: theme.serif }]}>{title}</Text>
        <Text style={[styles.settingsDescription, { color: theme.muted, fontFamily: theme.sans }]}>{description}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={danger ? theme.red : theme.muted} />
    </Pressable>
  );
}

function Feedback({ message, error }: { message: string; error: boolean }) {
  const theme = mobileTheme;
  return (
    <Text
      accessibilityRole={error ? "alert" : undefined}
      style={[
        styles.feedback,
        {
          color: error ? theme.red : theme.ink,
          borderLeftColor: error ? theme.red : theme.ink,
          backgroundColor: theme.paperSoft,
          fontFamily: theme.sans,
        },
      ]}
    >
      {message}
    </Text>
  );
}

function OperationSheet({
  visible,
  title,
  description,
  danger = false,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  description: string;
  danger?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const theme = mobileTheme;
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={[styles.sheetSafe, { backgroundColor: theme.paper }]}>
        <View style={[styles.sheetHeader, { borderBottomColor: danger ? theme.red : theme.ink }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={`关闭${title}`} onPress={onClose} hitSlop={10}>
            <Text style={[styles.sheetClose, { color: theme.red, fontFamily: theme.sans }]}>取消</Text>
          </Pressable>
          <Text style={[styles.sheetTitle, { color: danger ? theme.red : theme.ink, fontFamily: theme.serif }]}>{title}</Text>
          <View style={styles.sheetHeaderSpacer} />
        </View>
        <ScrollView contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
          <Text style={[styles.sheetDescription, { color: theme.muted, fontFamily: theme.sans }]}>{description}</Text>
          {children}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

export function AccountSecurityScreen() {
  const theme = mobileTheme;
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const {
    user,
    profile,
    busy,
    error,
    notice,
    changePassword,
    deleteAccount,
    signOut,
    clearFeedback,
  } = useMobileAuthStore();
  const [activeSheet, setActiveSheet] = useState<AccountSheet>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirmation, setNewPasswordConfirmation] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [deletePhrase, setDeletePhrase] = useState("");
  const [localError, setLocalError] = useState("");

  const openSheet = (sheet: Exclude<AccountSheet, null>) => {
    clearFeedback();
    setLocalError("");
    if (sheet === "password") {
      setCurrentPassword("");
      setNewPassword("");
      setNewPasswordConfirmation("");
    } else {
      setDeletePassword("");
      setDeletePhrase("");
    }
    setActiveSheet(sheet);
  };

  const closeSheet = () => {
    if (busy) return;
    clearFeedback();
    setLocalError("");
    setActiveSheet(null);
  };

  const savePassword = async () => {
    clearFeedback();
    setLocalError("");
    if (newPassword.length < 8) {
      setLocalError("新密码至少需要 8 位字符。");
      return;
    }
    if (newPassword !== newPasswordConfirmation) {
      setLocalError("两次输入的新密码不一致。");
      return;
    }
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setNewPasswordConfirmation("");
      setActiveSheet(null);
    } catch {
      // The shared auth store exposes a localized error below.
    }
  };

  const confirmDeletion = () => {
    clearFeedback();
    setLocalError("");
    if (deletePhrase !== "注销账号") {
      setLocalError("请输入“注销账号”确认这项操作。");
      return;
    }
    Alert.alert("永久注销账号", "账号及相关数据会永久删除，这项操作无法撤销。", [
      { text: "取消", style: "cancel" },
      {
        text: "永久注销",
        style: "destructive",
        onPress: () => {
          void deleteAccount(deletePassword)
            .then(() => navigation.goBack())
            .catch(() => undefined);
        },
      },
    ]);
  };

  if (!user) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.paper }]}>
        <View style={styles.empty}>
          <Text style={[styles.sectionTitle, { color: theme.ink, fontFamily: theme.serif }]}>账号已退出</Text>
          <Action label="返回" disabled={false} outline onPress={() => navigation.goBack()} />
        </View>
      </SafeAreaView>
    );
  }

  const feedback = localError || error || notice;
  const feedbackIsError = Boolean(localError || error);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.paper }]}>
      <ScreenHeader title="账号与安全" onBack={() => navigation.goBack()} />

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {!activeSheet && feedback ? <Feedback message={feedback} error={feedbackIsError} /> : null}

        <View style={[styles.card, { borderColor: theme.ink }]}>
          <Text style={[styles.sectionTitle, { color: theme.ink, fontFamily: theme.serif }]}>账号资料</Text>
          <InfoRow label="读者代号" value={profile?.display_name || "代号待分配"} />
          <InfoRow label="登录邮箱" value={user.email || "—"} />
          <Text style={[styles.helper, { color: theme.muted, fontFamily: theme.sans }]}>读者代号和登录邮箱暂不可修改。</Text>
        </View>

        <View style={[styles.card, { borderColor: theme.ink }]}>
          <Text style={[styles.sectionTitle, { color: theme.ink, fontFamily: theme.serif }]}>账号操作</Text>
          <SettingsRow title="修改密码" description="修改后，其他设备会退出登录。" disabled={busy} onPress={() => openSheet("password")} />
          <SettingsRow
            title="退出当前设备"
            description="不会影响其他已登录设备。"
            disabled={busy}
            onPress={() => {
              void signOut()
                .then(() => navigation.goBack())
                .catch(() => undefined);
            }}
          />
        </View>

        <View style={[styles.card, { borderColor: theme.red }]}>
          <Text style={[styles.sectionTitle, { color: theme.red, fontFamily: theme.serif }]}>危险操作</Text>
          <SettingsRow title="注销账号" description="账号及相关数据会永久删除。" disabled={busy} danger onPress={() => openSheet("delete")} />
        </View>
      </ScrollView>

      <OperationSheet
        visible={activeSheet === "password"}
        title="修改密码"
        description="保存后，其他设备会退出登录。"
        onClose={closeSheet}
      >
        {feedback ? <Feedback message={feedback} error={feedbackIsError} /> : null}
        <Field autoFocus label="当前密码" value={currentPassword} onChangeText={setCurrentPassword} secure />
        <Field label="新密码" value={newPassword} onChangeText={setNewPassword} secure />
        <Field label="再次输入新密码" value={newPasswordConfirmation} onChangeText={setNewPasswordConfirmation} secure />
        <Action label={busy ? "处理中…" : "保存新密码"} disabled={busy} onPress={() => void savePassword()} />
      </OperationSheet>

      <OperationSheet
        visible={activeSheet === "delete"}
        title="注销账号"
        description="这项操作无法撤销，请再次确认身份。"
        danger
        onClose={closeSheet}
      >
        {feedback ? <Feedback message={feedback} error={feedbackIsError} /> : null}
        <Field autoFocus label="当前密码" value={deletePassword} onChangeText={setDeletePassword} secure />
        <Field label="输入“注销账号”确认" value={deletePhrase} onChangeText={setDeletePhrase} />
        <Action label={busy ? "处理中…" : "永久注销账号"} disabled={busy} outline onPress={confirmDeletion} />
      </OperationSheet>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: { width: "100%", maxWidth: 760, alignSelf: "center", padding: 18, gap: 14 },
  card: { borderWidth: 1, padding: 18, gap: 14 },
  sectionTitle: { fontSize: 21, fontWeight: "900" },
  helper: { fontSize: 12, lineHeight: 20, fontWeight: "700" },
  infoRow: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 13, gap: 5 },
  infoLabel: { fontSize: 10, fontWeight: "800", letterSpacing: 0.8 },
  infoValue: { fontSize: 17, lineHeight: 26, fontWeight: "900" },
  settingsRow: { minHeight: 72, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14 },
  settingsCopy: { flex: 1, gap: 5 },
  settingsTitle: { fontSize: 16, fontWeight: "900" },
  settingsDescription: { fontSize: 11, lineHeight: 18, fontWeight: "700" },
  field: { gap: 7 },
  label: { fontSize: 11, fontWeight: "800" },
  input: { minHeight: 48, borderWidth: 1, paddingHorizontal: 12, fontSize: 14 },
  action: { minHeight: 48, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  actionText: { fontSize: 12, fontWeight: "900", letterSpacing: 1.5 },
  feedback: { borderLeftWidth: 4, padding: 12, fontSize: 12, lineHeight: 20, fontWeight: "700" },
  sheetSafe: { flex: 1 },
  sheetHeader: { minHeight: 58, borderBottomWidth: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 18 },
  sheetClose: { minWidth: 44, fontSize: 12, fontWeight: "900" },
  sheetTitle: { fontSize: 19, fontWeight: "900" },
  sheetHeaderSpacer: { width: 44 },
  sheetContent: { width: "100%", maxWidth: 620, alignSelf: "center", padding: 22, gap: 18 },
  sheetDescription: { fontSize: 12, lineHeight: 20, fontWeight: "700" },
  empty: { flex: 1, padding: 24, justifyContent: "center", gap: 18 },
});
