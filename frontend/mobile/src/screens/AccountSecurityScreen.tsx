import Ionicons from "@expo/vector-icons/Ionicons";
import { getProfileAvatarUrl } from "@jojo/auth";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import {
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { mobileAuthClient, useMobileAuthStore } from "../account/auth";
import type { RootStackParamList } from "../navigation/types";
import { mobileTheme } from "../theme/tokens";

function Field({
  label,
  value,
  onChangeText,
  secure = false,
  editable = true,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  secure?: boolean;
  editable?: boolean;
}) {
  const theme = mobileTheme;
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.ink, fontFamily: theme.sans }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={secure}
        editable={editable}
        autoCapitalize="none"
        style={[styles.input, { color: editable ? theme.ink : theme.muted, borderColor: theme.ruleDark, backgroundColor: editable ? theme.paper : theme.paperSoft, fontFamily: theme.sans }]}
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

export function AccountSecurityScreen() {
  const theme = mobileTheme;
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const {
    user,
    profile,
    busy,
    error,
    notice,
    uploadAvatarData,
    changePassword,
    deleteAccount,
    signOut,
    clearFeedback,
  } = useMobileAuthStore();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirmation, setNewPasswordConfirmation] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [deletePhrase, setDeletePhrase] = useState("");
  const [localError, setLocalError] = useState("");
  const avatarUrl = getProfileAvatarUrl(mobileAuthClient, profile?.avatar_path);

  const chooseAvatar = async () => {
    clearFeedback();
    setLocalError("");
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setLocalError("需要照片权限才能选择头像。");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [4, 5],
      quality: 0.82,
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return;
    try {
      const response = await fetch(asset.uri);
      const data = await response.arrayBuffer();
      if (data.byteLength > 2 * 1024 * 1024) {
        setLocalError("头像文件不能超过 2 MB。");
        return;
      }
      const contentType = asset.mimeType || "image/jpeg";
      const extension = asset.fileName?.split(".").pop() || contentType.split("/").pop() || "jpg";
      await uploadAvatarData(data, extension, contentType);
    } catch {
      setLocalError("头像上传没有完成，请稍后再试。");
    }
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
    Alert.alert("永久注销账号", "账号、资料和头像会永久删除，这项操作无法撤销。", [
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
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.paper }]}>
      <View style={[styles.header, { borderBottomColor: theme.ink }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="返回" onPress={() => navigation.goBack()} style={styles.back}>
          <Ionicons name="arrow-back" size={20} color={theme.red} />
          <Text style={[styles.backText, { color: theme.red, fontFamily: theme.sans }]}>返回</Text>
        </Pressable>
        <Text style={[styles.kicker, { color: theme.red, fontFamily: theme.sans }]}>ACCOUNT DOSSIER</Text>
        <Text style={[styles.title, { color: theme.ink, fontFamily: theme.serif }]}>账号与安全</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {feedback ? (
          <Text accessibilityRole={localError || error ? "alert" : undefined} style={[styles.feedback, { color: localError || error ? theme.red : theme.ink, borderLeftColor: localError || error ? theme.red : theme.ink, backgroundColor: theme.paperSoft, fontFamily: theme.sans }]}>{feedback}</Text>
        ) : null}

        <View style={[styles.card, { borderColor: theme.ink }]}>
          <Text style={[styles.sectionKicker, { color: theme.red, fontFamily: theme.sans }]}>PROFILE</Text>
          <Text style={[styles.sectionTitle, { color: theme.ink, fontFamily: theme.serif }]}>账号资料</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="更换头像" disabled={busy} onPress={() => void chooseAvatar()} style={[styles.avatar, { borderColor: theme.red, backgroundColor: theme.paperSoft }]}>
            {avatarUrl ? <Image source={{ uri: avatarUrl }} style={styles.avatarImage} /> : <Text style={[styles.avatarFallback, { color: theme.red }]}>{(profile?.display_name || user.email || "J").slice(0, 1)}</Text>}
            <Text style={[styles.avatarAction, { color: theme.inverse, fontFamily: theme.sans }]}>更换头像</Text>
          </Pressable>
          <Field label="读者代号（不可修改）" value={profile?.display_name || "代号待分配"} onChangeText={() => undefined} editable={false} />
          <Field label="登录邮箱（不可修改）" value={user.email || ""} onChangeText={() => undefined} editable={false} />
        </View>

        <View style={[styles.card, { borderColor: theme.ink }]}>
          <Text style={[styles.sectionKicker, { color: theme.red, fontFamily: theme.sans }]}>SECURITY</Text>
          <Text style={[styles.sectionTitle, { color: theme.ink, fontFamily: theme.serif }]}>修改密码</Text>
          <Text style={[styles.helper, { color: theme.muted, fontFamily: theme.sans }]}>修改后其他设备会退出登录。</Text>
          <Field label="当前密码" value={currentPassword} onChangeText={setCurrentPassword} secure />
          <Field label="新密码" value={newPassword} onChangeText={setNewPassword} secure />
          <Field label="再次输入新密码" value={newPasswordConfirmation} onChangeText={setNewPasswordConfirmation} secure />
          <Action label={busy ? "处理中…" : "修改密码"} disabled={busy} onPress={() => void savePassword()} />
        </View>

        <View style={[styles.card, { borderColor: theme.ink }]}>
          <Text style={[styles.sectionKicker, { color: theme.red, fontFamily: theme.sans }]}>SESSION</Text>
          <Text style={[styles.sectionTitle, { color: theme.ink, fontFamily: theme.serif }]}>当前设备</Text>
          <Action
            label="退出当前设备"
            disabled={busy}
            outline
            onPress={() => {
              void signOut()
                .then(() => navigation.goBack())
                .catch(() => undefined);
            }}
          />
        </View>

        <View style={[styles.card, { borderColor: theme.red }]}>
          <Text style={[styles.sectionKicker, { color: theme.red, fontFamily: theme.sans }]}>DANGER ZONE</Text>
          <Text style={[styles.sectionTitle, { color: theme.red, fontFamily: theme.serif }]}>注销账号</Text>
          <Text style={[styles.helper, { color: theme.muted, fontFamily: theme.sans }]}>注销后账号、资料和头像将永久删除。</Text>
          <Field label="当前密码" value={deletePassword} onChangeText={setDeletePassword} secure />
          <Field label="输入“注销账号”确认" value={deletePhrase} onChangeText={setDeletePhrase} />
          <Action label="永久注销账号" disabled={busy} outline onPress={confirmDeletion} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: { borderBottomWidth: 2, paddingHorizontal: 18, paddingBottom: 18 },
  back: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: 6 },
  backText: { fontSize: 12, fontWeight: "900" },
  kicker: { marginTop: 8, fontSize: 9, fontWeight: "900", letterSpacing: 2.2 },
  title: { marginTop: 7, fontSize: 30, fontWeight: "900" },
  content: { width: "100%", maxWidth: 760, alignSelf: "center", padding: 18, gap: 14 },
  card: { borderWidth: 1, padding: 18, gap: 14 },
  sectionKicker: { fontSize: 9, fontWeight: "900", letterSpacing: 2.1 },
  sectionTitle: { fontSize: 21, fontWeight: "900" },
  helper: { fontSize: 12, lineHeight: 20, fontWeight: "700" },
  field: { gap: 7 },
  label: { fontSize: 11, fontWeight: "800" },
  input: { minHeight: 48, borderWidth: 1, paddingHorizontal: 12, fontSize: 14 },
  action: { minHeight: 48, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  actionText: { fontSize: 12, fontWeight: "900", letterSpacing: 1.5 },
  avatar: { width: 92, height: 112, alignItems: "center", justifyContent: "center", overflow: "hidden", borderWidth: 2 },
  avatarImage: { width: "100%", height: "100%" },
  avatarFallback: { fontSize: 32, fontWeight: "900" },
  avatarAction: { position: "absolute", right: 0, bottom: 0, left: 0, padding: 4, textAlign: "center", backgroundColor: "rgba(32,32,32,.88)", fontSize: 9, fontWeight: "900" },
  feedback: { borderLeftWidth: 4, padding: 12, fontSize: 12, lineHeight: 20, fontWeight: "700" },
  empty: { flex: 1, padding: 24, justifyContent: "center", gap: 18 },
});
