import Ionicons from "@expo/vector-icons/Ionicons";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MOBILE_ACCOUNT_CONFIGURED, useMobileAuthStore } from "../account/auth";
import { shouldRefreshDialogViewport } from "../account/dialogViewport";
import { getRegistrationValidationError } from "../account/registration";
import { ScreenHeader } from "../components/ScreenHeader";
import { SectionTitle } from "../components/SectionTitle";
import { IS_EINK_RELEASE } from "../config/appVariant";
import type { RootStackParamList } from "../navigation/types";
import { mobileTheme, type MobileTheme } from "../theme/tokens";

type AccountMode = "login" | "register" | "recover";
type RecoveryStep = "email" | "code" | "password";

const spineShadowBands = [
  "rgba(32,32,32,0)",
  "rgba(32,32,32,.025)",
  "rgba(32,32,32,.05)",
  "rgba(32,32,32,.085)",
  "rgba(32,32,32,.13)",
] as const;

const gutterShadowBands = [
  "rgba(48,27,7,0)",
  "rgba(48,27,7,.06)",
  "rgba(48,27,7,.16)",
  "rgba(48,27,7,.42)",
  "rgba(42,22,6,.56)",
  "rgba(255,251,226,.22)",
  "rgba(48,27,7,0)",
] as const;

function PageSpineShadow() {
  return (
    <View pointerEvents="none" style={styles.pageSpineShadow}>
      {spineShadowBands.map((backgroundColor) => (
        <View key={backgroundColor} style={[styles.shadowBand, { backgroundColor }]} />
      ))}
    </View>
  );
}

function QuotePage({ theme }: { theme: MobileTheme }) {
  return (
    <View style={[styles.leftPage, { backgroundColor: IS_EINK_RELEASE ? theme.paper : "#fff9e9", borderColor: theme.rule }]}>
      <View style={[styles.quoteFrame, { borderColor: theme.red }]}>
        <Text style={[styles.quoteStar, { color: theme.red }]}>★</Text>
        <View style={[styles.quoteBody, { borderColor: theme.red }]}>
          <Text style={[styles.quoteLine, { color: theme.red, fontFamily: theme.serif }]}>“看它的过去，</Text>
          <Text style={[styles.quoteLine, { color: theme.red, fontFamily: theme.serif }]}>就可以知道它的现在；</Text>
          <Text style={[styles.quoteLine, { color: theme.red, fontFamily: theme.serif }]}>看它的过去和现在，</Text>
          <Text style={[styles.quoteLine, { color: theme.red, fontFamily: theme.serif }]}>就可以知道它的将来。”</Text>
          <Text style={[styles.quoteAuthor, { color: theme.muted, fontFamily: theme.serif }]}>——毛泽东</Text>
          <Text style={[styles.quoteSource, { color: theme.muted, fontFamily: theme.sans }]}>一九四五年八月十三日，延安干部会议{"\n"}《抗日战争胜利后的时局和我们的方针》</Text>
        </View>
      </View>
      <PageSpineShadow />
    </View>
  );
}

function VerificationCodeInput({
  value,
  theme,
  onChange,
  onSubmit,
}: {
  value: string;
  theme: MobileTheme;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const activeIndex = Math.min(value.length, 5);

  return (
    <View style={styles.codeEntry}>
      <View pointerEvents="none" style={styles.codeSlots}>
        {Array.from({ length: 6 }, (_, index) => {
          const digit = value[index] ?? "";
          const active = index === activeIndex;
          return (
            <View
              key={index}
              style={[
                styles.codeSlot,
                {
                  borderColor: digit || active ? theme.red : theme.ruleDark,
                  backgroundColor: digit ? "rgba(139,26,26,.045)" : theme.paper,
                  borderBottomWidth: active ? 3 : 1,
                },
              ]}
            >
              <Text style={[styles.codeDigit, { color: theme.red, fontFamily: theme.serif }]}>
                {digit || " "}
              </Text>
            </View>
          );
        })}
      </View>
      <TextInput
        accessibilityLabel="6 位验证码"
        value={value}
        onChangeText={(nextValue) => onChange(nextValue.replace(/\D/g, "").slice(0, 6))}
        autoComplete="one-time-code"
        autoFocus
        caretHidden
        keyboardType="number-pad"
        maxLength={6}
        returnKeyType="done"
        onSubmitEditing={onSubmit}
        style={styles.codeHiddenInput}
      />
    </View>
  );
}

export function MeScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const theme = mobileTheme;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accountMode, setAccountMode] = useState<AccountMode>("login");
  const [registrationEmail, setRegistrationEmail] = useState("");
  const [registrationPassword, setRegistrationPassword] = useState("");
  const [registrationPasswordConfirmation, setRegistrationPasswordConfirmation] = useState("");
  const [invitationCode, setInvitationCode] = useState("");
  const [confirmationEmail, setConfirmationEmail] = useState<string | null>(null);
  const [confirmationCode, setConfirmationCode] = useState("");
  const [recoveryStep, setRecoveryStep] = useState<RecoveryStep>("email");
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [recoveryPasswordConfirmation, setRecoveryPasswordConfirmation] = useState("");
  const [resendSeconds, setResendSeconds] = useState(0);
  const [localError, setLocalError] = useState("");
  const [loginVisible, setLoginVisible] = useState(false);
  const [dialogViewport, setDialogViewport] = useState(() => ({ width: windowWidth, height: windowHeight }));
  const closingRef = useRef(false);
  const openAnimationRef = useRef<Animated.CompositeAnimation | null>(null);
  const latestWindowSizeRef = useRef({ width: windowWidth, height: windowHeight });
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const cameraProgress = useRef(new Animated.Value(0)).current;
  const coverProgress = useRef(new Animated.Value(0)).current;
  const {
    initialized,
    user,
    profile,
    busy,
    error,
    notice,
    signIn,
    signUp,
    confirmSignUp,
    resendSignUpCode,
    sendPasswordReset,
    verifyPasswordResetCode,
    completePasswordRecovery,
    signOut,
    clearFeedback,
  } = useMobileAuthStore();
  const dialogWidth = loginVisible ? dialogViewport.width : windowWidth;
  const dialogHeight = loginVisible ? dialogViewport.height : windowHeight;
  const wideBook = dialogWidth > 880;
  const bookWidth = wideBook
    ? Math.min(976, dialogWidth - 112, (dialogHeight - 112) * (61 / 42))
    : dialogWidth * 1.8;
  // A portrait spread is deliberately wider than the viewport so the camera
  // lands on the form page. Derive its height from one leaf, otherwise wide
  // Android display modes turn the leaf into a shallow landscape rectangle.
  const portraitLeafWidth = bookWidth / 2;
  const bookHeight = wideBook
    ? bookWidth * (42 / 61)
    : Math.min(dialogHeight - 64, portraitLeafWidth / 0.7);
  const bookEndOffset = wideBook ? 0 : -bookWidth / 2 + dialogWidth * 0.05;
  const bookStartOffset = wideBook ? -bookWidth * 0.24 : bookEndOffset + dialogWidth * 0.03;
  const coverHoldDuration = wideBook ? 500 : 580;
  latestWindowSizeRef.current = { width: windowWidth, height: windowHeight };

  useEffect(() => {
    if (resendSeconds <= 0) return undefined;
    const timer = setInterval(() => setResendSeconds((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearInterval(timer);
  }, [resendSeconds]);

  useEffect(() => {
    if (!loginVisible) return;
    // adjustResize changes only the window height while the keyboard animates.
    // Treating width > height as orientation would mistake that transient frame
    // for landscape and make the whole book shrink, jump, then rebound.
    if (!shouldRefreshDialogViewport(dialogViewport.width, windowWidth)) return;
    if (IS_EINK_RELEASE || !openAnimationRef.current) {
      setDialogViewport({ width: windowWidth, height: windowHeight });
    }
  }, [dialogViewport.height, dialogViewport.width, loginVisible, windowHeight, windowWidth]);

  const openAccount = (mode: AccountMode) => {
    closingRef.current = false;
    openAnimationRef.current?.stop();
    openAnimationRef.current = null;
    clearFeedback();
    setLocalError("");
    setAccountMode(mode);
    // A translucent native Modal may briefly report a different window height
    // while it mounts. Freeze the pre-open viewport so the book stays on one
    // horizontal baseline throughout the entrance.
    setDialogViewport({ width: windowWidth, height: windowHeight });

    if (IS_EINK_RELEASE) {
      backdropOpacity.setValue(1);
      cameraProgress.setValue(1);
      coverProgress.setValue(1);
      setLoginVisible(true);
      return;
    }

    // Reset before mounting the native Modal so it cannot expose one frame of
    // the previous, fully-open book state.
    backdropOpacity.setValue(0);
    cameraProgress.setValue(0);
    coverProgress.setValue(0);
    setLoginVisible(true);
    requestAnimationFrame(() => {
      const coverDuration = wideBook ? 1240 : 1080;
      const animation = Animated.parallel([
        Animated.timing(backdropOpacity, {
          toValue: 1,
          duration: 180,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        // Hold on the cover before scheduling both native-driven transforms.
        Animated.timing(cameraProgress, {
          toValue: 1,
          delay: coverHoldDuration,
          duration: wideBook ? 1320 : 1120,
          easing: Easing.bezier(0.38, 0.12, 0.12, 1),
          useNativeDriver: true,
        }),
        Animated.timing(coverProgress, {
          toValue: 1,
          delay: coverHoldDuration,
          duration: coverDuration,
          easing: Easing.bezier(0.42, 0.1, 0.16, 1),
          useNativeDriver: true,
        }),
      ]);
      openAnimationRef.current = animation;
      animation.start(() => {
        if (openAnimationRef.current !== animation) return;
        openAnimationRef.current = null;
        const latestSize = latestWindowSizeRef.current;
        if (shouldRefreshDialogViewport(dialogViewport.width, latestSize.width)) {
          setDialogViewport(latestSize);
        }
      });
    });
  };

  const changeAccountMode = (mode: AccountMode) => {
    clearFeedback();
    setLocalError("");
    setAccountMode(mode);
    if (mode === "recover") {
      setRecoveryStep("email");
      setRecoveryEmail(email.trim());
      setRecoveryCode("");
    }
  };

  const closeLogin = (force = false) => {
    if ((busy && !force) || closingRef.current) return;
    closingRef.current = true;
    openAnimationRef.current?.stop();
    openAnimationRef.current = null;
    Keyboard.dismiss();
    setLoginVisible(false);
    backdropOpacity.setValue(0);
    cameraProgress.setValue(0);
    coverProgress.setValue(0);
    closingRef.current = false;
  };

  const handleSignIn = async () => {
    clearFeedback();
    setLocalError("");
    if (!MOBILE_ACCOUNT_CONFIGURED) {
      setLocalError("账号服务未配置。");
      return;
    }
    if (!email.trim() || !password) {
      setLocalError("请输入邮箱和密码。");
      return;
    }
    try {
      await signIn(email.trim(), password);
      setPassword("");
      closeLogin(true);
    } catch {
      // The shared auth store exposes a localized error below.
    }
  };

  const handleSignUp = async () => {
    clearFeedback();
    setLocalError("");
    if (!MOBILE_ACCOUNT_CONFIGURED) {
      setLocalError("账号服务未配置。");
      return;
    }
    const normalizedEmail = registrationEmail.trim();
    if (!normalizedEmail) {
      setLocalError("请输入邮箱。");
      return;
    }
    const validationError = getRegistrationValidationError(invitationCode, registrationPassword);
    if (validationError) {
      setLocalError(validationError);
      return;
    }
    if (registrationPassword !== registrationPasswordConfirmation) {
      setLocalError("两次输入的密码不一致。");
      return;
    }
    try {
      const requiresConfirmation = await signUp({
        invitationCode: invitationCode.trim(),
        email: normalizedEmail,
        password: registrationPassword,
      });
      setRegistrationPassword("");
      setRegistrationPasswordConfirmation("");
      if (requiresConfirmation) {
        setConfirmationEmail(normalizedEmail);
        setConfirmationCode("");
        setResendSeconds(60);
      } else {
        closeLogin(true);
      }
    } catch {
      // The shared auth store exposes a localized error below.
    }
  };

  const handleConfirmSignUp = async () => {
    clearFeedback();
    setLocalError("");
    if (!confirmationEmail || !/^\d{6}$/.test(confirmationCode)) {
      setLocalError("请输入邮件中的 6 位验证码。");
      return;
    }
    try {
      await confirmSignUp(confirmationEmail, confirmationCode);
      closeLogin(true);
    } catch {
      // The shared auth store exposes a localized error below.
    }
  };

  const resendCode = async () => {
    if (resendSeconds > 0) return;
    try {
      if (accountMode === "register" && confirmationEmail) {
        await resendSignUpCode(confirmationEmail);
      } else {
        await sendPasswordReset(recoveryEmail.trim());
      }
      setResendSeconds(60);
    } catch {
      // The shared auth store exposes a localized error below.
    }
  };

  const handleRecovery = async () => {
    clearFeedback();
    setLocalError("");
    try {
      if (recoveryStep === "email") {
        if (!recoveryEmail.trim()) {
          setLocalError("请输入注册邮箱。");
          return;
        }
        await sendPasswordReset(recoveryEmail.trim());
        setRecoveryStep("code");
        setResendSeconds(60);
        return;
      }
      if (recoveryStep === "code") {
        if (!/^\d{6}$/.test(recoveryCode)) {
          setLocalError("请输入邮件中的 6 位验证码。");
          return;
        }
        await verifyPasswordResetCode(recoveryEmail.trim(), recoveryCode);
        setRecoveryStep("password");
        return;
      }
      if (recoveryPassword.length < 8) {
        setLocalError("新密码至少需要 8 位字符。");
        return;
      }
      if (recoveryPassword !== recoveryPasswordConfirmation) {
        setLocalError("两次输入的新密码不一致。");
        return;
      }
      await completePasswordRecovery(recoveryPassword);
      setEmail(recoveryEmail.trim());
      setPassword("");
      closeLogin(true);
    } catch {
      // The shared auth store exposes a localized error below.
    }
  };

  return (
    <SafeAreaView edges={["top"]} style={[styles.safe, { backgroundColor: theme.paper }]}>
      <ScreenHeader title="账号" onBack={() => navigation.goBack()} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingBottom: 24 }]}
        showsVerticalScrollIndicator={false}
        overScrollMode={IS_EINK_RELEASE ? "never" : "always"}
      >
        <SectionTitle title="账号" />
        <View style={[styles.panel, { borderColor: theme.rule, backgroundColor: theme.paper }]}>
          {!initialized ? (
            <View style={styles.loadingRow}>
              {IS_EINK_RELEASE ? null : <ActivityIndicator size="small" color={theme.red} />}
              <Text style={[styles.statusText, { color: theme.muted, fontFamily: theme.sans }]}>正在读取账号</Text>
            </View>
          ) : user ? (
            <>
              <View style={[styles.infoRow, { borderBottomColor: theme.rule }]}>
                <Text style={[styles.infoLabel, { color: theme.muted, fontFamily: theme.sans }]}>读者代号</Text>
                <Text style={[styles.infoValue, { color: theme.ink, fontFamily: theme.serif }]}>{profile?.display_name || "代号待分配"}</Text>
              </View>
              <View style={[styles.infoRow, { borderBottomColor: theme.rule }]}>
                <Text style={[styles.infoLabel, { color: theme.muted, fontFamily: theme.sans }]}>邮箱</Text>
                <Text numberOfLines={1} style={[styles.infoValue, { color: theme.ink, fontFamily: theme.sans }]}>{user.email || "—"}</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                onPress={() => navigation.navigate("AccountSecurity")}
                style={({ pressed }) => [styles.accountEntry, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.rule }, pressed && { backgroundColor: theme.paperSoft }]}
              >
                <Ionicons name="shield-checkmark-outline" size={20} color={theme.ink} />
                <Text style={[styles.accountEntryText, { color: theme.ink, fontFamily: theme.serif }]}>账号与安全</Text>
                <Ionicons name="chevron-forward" size={17} color={theme.muted} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => void signOut().catch(() => undefined)}
                style={({ pressed }) => [styles.signOutButton, { opacity: busy ? 0.45 : pressed ? 0.72 : 1 }]}
              >
                <Text style={[styles.signOutText, { color: theme.red, fontFamily: theme.sans }]}>{busy ? "退出中" : "退出登录"}</Text>
              </Pressable>
            </>
          ) : (
            <View style={styles.readerEntry}>
              <Text style={[styles.readerEntryStar, { color: theme.red }]}>★</Text>
              <Text style={[styles.readerEntryTitle, { color: theme.ink, fontFamily: theme.serif }]}>读者入口</Text>
              <Text style={[styles.readerEntryCopy, { color: theme.muted, fontFamily: theme.sans }]}>登录已有账号，或凭邀请码完成注册。</Text>
              <View style={styles.readerEntryActions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="登录"
                  onPress={() => openAccount("login")}
                  style={({ pressed }) => [styles.readerEntryButton, { borderColor: theme.red, backgroundColor: theme.red }, pressed && styles.readerEntryButtonPressed]}
                >
                  <Text style={[styles.readerEntryButtonText, { color: theme.inverse, fontFamily: theme.serif }]}>登录</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="注册"
                  onPress={() => openAccount("register")}
                  style={({ pressed }) => [styles.readerEntryButton, { borderColor: theme.red, backgroundColor: theme.paper }, pressed && styles.readerEntryButtonPressed]}
                >
                  <Text style={[styles.readerEntryButtonText, { color: theme.red, fontFamily: theme.serif }]}>注册</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>

        <View style={styles.sectionGap}>
          <SectionTitle title="设置" />
          <View style={[styles.panel, { borderColor: theme.rule, backgroundColor: theme.paper }]}>
            {([
              { section: "reading" as const, label: "阅读设置", icon: "book-outline" as const },
              { section: "interaction" as const, label: "交互设置", icon: "hand-left-outline" as const },
              { section: "times" as const, label: "时事设置", icon: "newspaper-outline" as const },
              { section: "data" as const, label: "阅读数据", icon: "time-outline" as const },
              { section: "about" as const, label: "关于", icon: "information-circle-outline" as const },
            ]).map((item, index, items) => (
              <Pressable
                key={item.section}
                accessibilityRole="button"
                onPress={() => navigation.navigate("Settings", { section: item.section })}
                style={({ pressed }) => [
                  styles.settingsRow,
                  index < items.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.rule },
                  pressed && { backgroundColor: theme.paperSoft },
                ]}
              >
                <Ionicons name={item.icon} size={19} color={theme.ink} />
                <Text style={[styles.settingsText, { color: theme.ink, fontFamily: theme.serif }]}>{item.label}</Text>
                <Ionicons name="chevron-forward" size={17} color={theme.muted} />
              </Pressable>
            ))}
          </View>
        </View>
      </ScrollView>

      <Modal
        animationType="none"
        transparent
        statusBarTranslucent
        visible={loginVisible}
        onRequestClose={() => closeLogin()}
      >
        <Animated.View
          accessibilityViewIsModal
          style={[styles.modalOverlay, { backgroundColor: theme.paper, opacity: backdropOpacity }]}
        >
          <Pressable accessibilityLabel={accountMode === "register" ? "关闭注册" : accountMode === "recover" ? "关闭找回密码" : "关闭登录"} onPress={() => closeLogin()} style={StyleSheet.absoluteFill} />
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            pointerEvents="box-none"
            style={[
              styles.dialogLayout,
              Platform.OS === "android" && {
                flex: 0,
                width: dialogWidth,
                height: dialogHeight,
              },
            ]}
          >
            <View
              style={[
                styles.bookViewport,
                {
                  width: wideBook ? bookWidth : windowWidth,
                  height: bookHeight,
                  overflow: wideBook ? "visible" : "hidden",
                },
              ]}
            >
              <Animated.View
                style={[
                  styles.openBook,
                  {
                    width: bookWidth,
                    height: bookHeight,
                    transform: [
                      {
                        translateX: cameraProgress.interpolate({
                          inputRange: [0, 1],
                          outputRange: [bookStartOffset, bookEndOffset],
                        }),
                      },
                      {
                        rotateZ: cameraProgress.interpolate({
                          inputRange: [0, 1],
                          outputRange: [wideBook ? "-0.65deg" : "0deg", wideBook ? "-0.16deg" : "0deg"],
                        }),
                      },
                      {
                        scale: cameraProgress.interpolate({
                          inputRange: [0, 1],
                          outputRange: [wideBook ? 0.98 : 0.94, 1],
                        }),
                      },
                    ],
                  },
                ]}
              >
                <View style={[styles.rightCover, { backgroundColor: theme.red, borderColor: theme.redDark }]}>
                  <View style={[styles.rightPage, { backgroundColor: IS_EINK_RELEASE ? theme.paper : "#fff9e9", borderColor: theme.rule }]}>
                    <ScrollView
                      bounces={false}
                      keyboardShouldPersistTaps="handled"
                      showsVerticalScrollIndicator={false}
                      contentContainerStyle={[styles.dialogContent, { minHeight: bookHeight - 18 }]}
                    >
                      <View style={[styles.bookHeader, { borderBottomColor: theme.ink }]}>
                        <Text style={[styles.bookHeaderText, { color: theme.ink, fontFamily: theme.sans }]}>读者登记</Text>
                        <Text style={[styles.bookNumber, { color: theme.red, fontFamily: theme.sans }]}>第 01 号</Text>
                      </View>
                      <View accessibilityRole="tablist" style={[styles.modeTabs, { borderBottomColor: theme.rule }]}>
                        {(["login", "register"] as const).map((mode) => {
                          const selected = accountMode === mode;
                          return (
                            <Pressable
                              key={mode}
                              accessibilityRole="tab"
                              accessibilityState={{ selected }}
                              disabled={busy}
                              onPress={() => changeAccountMode(mode)}
                              style={[styles.modeTab, selected && { borderBottomColor: theme.red }]}
                            >
                              <Text style={[styles.modeTabText, { color: selected ? theme.red : theme.muted, fontFamily: theme.serif }]}>{mode === "login" ? "登录" : "注册"}</Text>
                            </Pressable>
                          );
                        })}
                      </View>
                      {accountMode === "login" ? (
                        <View style={styles.form}>
                          <Text style={[styles.fieldLabel, { color: theme.ink, fontFamily: theme.sans }]}>邮箱</Text>
                          <TextInput
                            value={email}
                            onChangeText={(value) => { setEmail(value); setLocalError(""); clearFeedback(); }}
                            autoCapitalize="none"
                            autoCorrect={false}
                            autoComplete="email"
                            keyboardType="email-address"
                            textContentType="emailAddress"
                            returnKeyType="next"
                            placeholder="name@example.com"
                            placeholderTextColor={theme.muted}
                            style={[styles.input, { color: theme.ink, borderBottomColor: theme.ruleDark, fontFamily: theme.sans }]}
                          />
                          <Text style={[styles.fieldLabel, styles.passwordLabel, { color: theme.ink, fontFamily: theme.sans }]}>密码</Text>
                          <TextInput
                            value={password}
                            onChangeText={(value) => { setPassword(value); setLocalError(""); clearFeedback(); }}
                            autoCapitalize="none"
                            autoCorrect={false}
                            autoComplete="current-password"
                            textContentType="password"
                            secureTextEntry
                            returnKeyType="done"
                            onSubmitEditing={() => void handleSignIn()}
                            placeholder="输入密码"
                            placeholderTextColor={theme.muted}
                            style={[styles.input, { color: theme.ink, borderBottomColor: theme.ruleDark, fontFamily: theme.sans }]}
                          />
                          {localError || error || notice ? (
                            <Text accessibilityRole={localError || error ? "alert" : undefined} style={[styles.error, { color: localError || error ? theme.red : theme.muted, fontFamily: theme.sans }]}>{localError || error || notice}</Text>
                          ) : null}
                          <Pressable
                            accessibilityRole="button"
                            disabled={busy}
                            onPress={() => void handleSignIn()}
                            style={({ pressed }) => [styles.loginButton, { backgroundColor: theme.red, opacity: busy ? 0.45 : pressed ? 0.78 : 1 }]}
                          >
                            <Text style={[styles.loginText, { color: theme.inverse, fontFamily: theme.serif }]}>{busy ? "正在登录…" : "登录"}</Text>
                          </Pressable>
                          <Pressable accessibilityRole="button" disabled={busy} onPress={() => changeAccountMode("recover")}>
                            <Text style={[styles.textAction, { color: theme.red, fontFamily: theme.sans }]}>忘记密码？</Text>
                          </Pressable>
                        </View>
                      ) : accountMode === "register" && confirmationEmail ? (
                        <View style={styles.form}>
                          <Text style={[styles.confirmationText, { color: theme.muted, fontFamily: theme.sans }]}>验证码已发送到 {confirmationEmail}</Text>
                          <Text style={[styles.fieldLabel, { color: theme.ink, fontFamily: theme.sans }]}>6 位验证码</Text>
                          <VerificationCodeInput
                            value={confirmationCode}
                            theme={theme}
                            onChange={(value) => { setConfirmationCode(value); setLocalError(""); clearFeedback(); }}
                            onSubmit={() => void handleConfirmSignUp()}
                          />
                          {localError || error || notice ? (
                            <Text accessibilityRole={localError || error ? "alert" : undefined} style={[styles.error, { color: localError || error ? theme.red : theme.muted, fontFamily: theme.sans }]}>{localError || error || notice}</Text>
                          ) : null}
                          <Pressable accessibilityRole="button" disabled={busy} onPress={() => void handleConfirmSignUp()} style={({ pressed }) => [styles.loginButton, { backgroundColor: theme.red, opacity: busy ? 0.45 : pressed ? 0.78 : 1 }]}>
                            <Text style={[styles.loginText, { color: theme.inverse, fontFamily: theme.serif }]}>{busy ? "正在验证…" : "确认并完成注册"}</Text>
                          </Pressable>
                          <Pressable accessibilityRole="button" disabled={busy || resendSeconds > 0} onPress={() => void resendCode()}>
                            <Text style={[styles.textAction, { color: theme.red, fontFamily: theme.sans }]}>{resendSeconds > 0 ? `${resendSeconds} 秒后可重发` : "重新发送验证码"}</Text>
                          </Pressable>
                          <Pressable accessibilityRole="button" disabled={busy} onPress={() => { clearFeedback(); setLocalError(""); setConfirmationEmail(null); setConfirmationCode(""); }}>
                            <Text style={[styles.textAction, { color: theme.red, fontFamily: theme.sans }]}>修改注册信息</Text>
                          </Pressable>
                        </View>
                      ) : accountMode === "register" ? (
                        <View style={styles.form}>
                          <Text style={[styles.fieldLabel, { color: theme.ink, fontFamily: theme.sans }]}>邮箱</Text>
                          <TextInput
                            value={registrationEmail}
                            onChangeText={(value) => { setRegistrationEmail(value); setLocalError(""); clearFeedback(); }}
                            autoCapitalize="none"
                            autoCorrect={false}
                            autoComplete="email"
                            keyboardType="email-address"
                            textContentType="emailAddress"
                            returnKeyType="next"
                            placeholder="name@example.com"
                            placeholderTextColor={theme.muted}
                            style={[styles.input, { color: theme.ink, borderBottomColor: theme.ruleDark, fontFamily: theme.sans }]}
                          />
                          <Text style={[styles.fieldLabel, styles.passwordLabel, { color: theme.ink, fontFamily: theme.sans }]}>密码</Text>
                          <TextInput
                            value={registrationPassword}
                            onChangeText={(value) => { setRegistrationPassword(value); setLocalError(""); clearFeedback(); }}
                            autoCapitalize="none"
                            autoCorrect={false}
                            autoComplete="new-password"
                            textContentType="newPassword"
                            secureTextEntry
                            returnKeyType="next"
                            placeholder="至少 8 位字符"
                            placeholderTextColor={theme.muted}
                            style={[styles.input, { color: theme.ink, borderBottomColor: theme.ruleDark, fontFamily: theme.sans }]}
                          />
                          <Text style={[styles.fieldLabel, styles.passwordLabel, { color: theme.ink, fontFamily: theme.sans }]}>再次输入密码</Text>
                          <TextInput
                            value={registrationPasswordConfirmation}
                            onChangeText={(value) => { setRegistrationPasswordConfirmation(value); setLocalError(""); clearFeedback(); }}
                            autoCapitalize="none"
                            autoCorrect={false}
                            autoComplete="new-password"
                            textContentType="newPassword"
                            secureTextEntry
                            returnKeyType="next"
                            placeholder="重复输入密码"
                            placeholderTextColor={theme.muted}
                            style={[styles.input, { color: theme.ink, borderBottomColor: theme.ruleDark, fontFamily: theme.sans }]}
                          />
                          <Text style={[styles.fieldLabel, styles.passwordLabel, { color: theme.ink, fontFamily: theme.sans }]}>邀请码</Text>
                          <TextInput
                            value={invitationCode}
                            onChangeText={(value) => { setInvitationCode(value); setLocalError(""); clearFeedback(); }}
                            autoCapitalize="characters"
                            autoCorrect={false}
                            autoComplete="off"
                            maxLength={6}
                            returnKeyType="done"
                            onSubmitEditing={() => void handleSignUp()}
                            placeholder="6 位邀请码"
                            placeholderTextColor={theme.muted}
                            style={[styles.input, { color: theme.ink, borderBottomColor: theme.ruleDark, fontFamily: theme.sans }]}
                          />
                          {localError || error || notice ? (
                            <Text accessibilityRole={localError || error ? "alert" : undefined} style={[styles.error, { color: localError || error ? theme.red : theme.muted, fontFamily: theme.sans }]}>{localError || error || notice}</Text>
                          ) : null}
                          <Pressable
                            accessibilityRole="button"
                            disabled={busy}
                            onPress={() => void handleSignUp()}
                            style={({ pressed }) => [styles.loginButton, { backgroundColor: theme.red, opacity: busy ? 0.45 : pressed ? 0.78 : 1 }]}
                          >
                            <Text style={[styles.loginText, { color: theme.inverse, fontFamily: theme.serif }]}>{busy ? "正在注册…" : "发送注册验证码"}</Text>
                          </Pressable>
                        </View>
                      ) : (
                        <View style={styles.form}>
                          <Text style={[styles.recoveryTitle, { color: theme.ink, fontFamily: theme.serif }]}>{recoveryStep === "password" ? "设置新密码" : "找回密码"}</Text>
                          <Text style={[styles.confirmationText, { color: theme.muted, fontFamily: theme.sans }]}>{recoveryStep === "email" ? "验证码会发送到你的注册邮箱。" : `正在验证 ${recoveryEmail}`}</Text>
                          {recoveryStep === "email" ? (
                            <>
                              <Text style={[styles.fieldLabel, { color: theme.ink, fontFamily: theme.sans }]}>注册邮箱</Text>
                              <TextInput
                                value={recoveryEmail}
                                onChangeText={(value) => { setRecoveryEmail(value); setLocalError(""); clearFeedback(); }}
                                autoCapitalize="none"
                                autoCorrect={false}
                                autoComplete="email"
                                keyboardType="email-address"
                                textContentType="emailAddress"
                                placeholder="name@example.com"
                                placeholderTextColor={theme.muted}
                                style={[styles.input, { color: theme.ink, borderBottomColor: theme.ruleDark, fontFamily: theme.sans }]}
                              />
                            </>
                          ) : recoveryStep === "code" ? (
                            <>
                              <Text style={[styles.fieldLabel, { color: theme.ink, fontFamily: theme.sans }]}>6 位验证码</Text>
                              <VerificationCodeInput
                                value={recoveryCode}
                                theme={theme}
                                onChange={(value) => { setRecoveryCode(value); setLocalError(""); clearFeedback(); }}
                                onSubmit={() => void handleRecovery()}
                              />
                            </>
                          ) : (
                            <>
                              <Text style={[styles.fieldLabel, { color: theme.ink, fontFamily: theme.sans }]}>新密码</Text>
                              <TextInput
                                value={recoveryPassword}
                                onChangeText={(value) => { setRecoveryPassword(value); setLocalError(""); clearFeedback(); }}
                                autoComplete="new-password"
                                secureTextEntry
                                style={[styles.input, { color: theme.ink, borderBottomColor: theme.ruleDark, fontFamily: theme.sans }]}
                              />
                              <Text style={[styles.fieldLabel, styles.passwordLabel, { color: theme.ink, fontFamily: theme.sans }]}>再次输入新密码</Text>
                              <TextInput
                                value={recoveryPasswordConfirmation}
                                onChangeText={(value) => { setRecoveryPasswordConfirmation(value); setLocalError(""); clearFeedback(); }}
                                autoComplete="new-password"
                                secureTextEntry
                                returnKeyType="done"
                                onSubmitEditing={() => void handleRecovery()}
                                style={[styles.input, { color: theme.ink, borderBottomColor: theme.ruleDark, fontFamily: theme.sans }]}
                              />
                            </>
                          )}
                          {localError || error || notice ? (
                            <Text accessibilityRole={localError || error ? "alert" : undefined} style={[styles.error, { color: localError || error ? theme.red : theme.muted, fontFamily: theme.sans }]}>{localError || error || notice}</Text>
                          ) : null}
                          <Pressable accessibilityRole="button" disabled={busy} onPress={() => void handleRecovery()} style={({ pressed }) => [styles.loginButton, { backgroundColor: theme.red, opacity: busy ? 0.45 : pressed ? 0.78 : 1 }]}>
                            <Text style={[styles.loginText, { color: theme.inverse, fontFamily: theme.serif }]}>{busy ? "处理中…" : recoveryStep === "email" ? "发送验证码" : recoveryStep === "code" ? "验证身份" : "保存新密码"}</Text>
                          </Pressable>
                          {recoveryStep === "code" ? (
                            <Pressable accessibilityRole="button" disabled={busy || resendSeconds > 0} onPress={() => void resendCode()}>
                              <Text style={[styles.textAction, { color: theme.red, fontFamily: theme.sans }]}>{resendSeconds > 0 ? `${resendSeconds} 秒后可重发` : "重新发送验证码"}</Text>
                            </Pressable>
                          ) : null}
                          <Pressable accessibilityRole="button" disabled={busy} onPress={() => changeAccountMode("login")}>
                            <Text style={[styles.textAction, { color: theme.red, fontFamily: theme.sans }]}>返回登录</Text>
                          </Pressable>
                        </View>
                      )}
                      <View style={[styles.bookFooter, { borderTopColor: theme.rule }]}>
                        <Text style={[styles.bookFooterText, { color: theme.muted, fontFamily: theme.sans }]}>登记日期：二〇二六年</Text>
                        <Text style={[styles.bookFooterText, { color: theme.red, fontFamily: theme.sans }]}>JOJO 看报</Text>
                      </View>
                    </ScrollView>
                    <Animated.View
                      pointerEvents="none"
                      style={[
                        styles.rightPageTurnShadow,
                        {
                          opacity: coverProgress.interpolate({
                            inputRange: [0, 0.18, 0.52, 0.86, 1],
                            outputRange: [0, 0.04, 0.24, 0.07, 0],
                          }),
                          transform: [{
                            scaleX: coverProgress.interpolate({
                              inputRange: [0, 0.18, 0.48, 0.76, 1],
                              outputRange: [0.18, 0.18, 1, 0.55, 0.15],
                            }),
                          }],
                        },
                      ]}
                    >
                      {[...spineShadowBands].reverse().map((backgroundColor) => (
                        <View key={backgroundColor} style={[styles.shadowBand, { backgroundColor }]} />
                      ))}
                    </Animated.View>
                  </View>
                </View>

                <Animated.View
                  collapsable={false}
                  pointerEvents="none"
                  style={[
                    styles.turningPage,
                    {
                      transform: [
                        {
                          // Android's 3D View renderer can drop a back face after
                          // it crosses 90deg. Project the same rigid 168deg hinge
                          // turn into 2D instead. Negative scale places this very
                          // same leaf on the left; there is no resting-page swap.
                          scaleX: coverProgress.interpolate({
                            inputRange: [0, 0.125, 0.25, 0.375, 0.5, 0.5357, 0.625, 0.75, 0.875, 1],
                            outputRange: [1, 0.934, 0.743, 0.454, 0.105, 0.001, -0.259, -0.588, -0.839, -0.978],
                          }),
                        },
                      ],
                    },
                  ]}
                >
                  <Animated.View
                    collapsable={false}
                    renderToHardwareTextureAndroid
                    style={[
                      styles.turningFace,
                      styles.turningFront,
                      {
                        backgroundColor: theme.red,
                        borderColor: theme.redDark,
                        opacity: coverProgress.interpolate({
                          inputRange: [0, 0.522, 0.536, 1],
                          outputRange: [1, 1, 0, 0],
                        }),
                      },
                    ]}
                  >
                    <View style={[styles.coverFrame, { borderColor: "#ddb239" }]} />
                    <Text style={[styles.coverMotto, { color: "#ddb239", fontFamily: theme.serif }]}>全世界无产者，联合起来！</Text>
                    <Text style={[styles.coverStar, { color: "#ddb239" }]}>★</Text>
                    <Text style={[styles.coverTitle, { color: "#ddb239", fontFamily: theme.serif }]}>{accountMode === "register" ? "读者注册" : accountMode === "recover" ? "找回密码" : "读者登录"}</Text>
                    <Animated.View
                      pointerEvents="none"
                      style={[
                        styles.turningEdge,
                        {
                          backgroundColor: theme.redDark,
                          opacity: coverProgress.interpolate({
                            inputRange: [0, 0.28, 0.5, 0.72, 1],
                            outputRange: [0, 0.15, 0.72, 0.18, 0],
                          }),
                        },
                      ]}
                    />
                  </Animated.View>
                  <Animated.View
                    collapsable={false}
                    renderToHardwareTextureAndroid
                    style={[
                      styles.turningFace,
                      styles.turningBack,
                      {
                        backgroundColor: theme.red,
                        borderColor: theme.redDark,
                        opacity: coverProgress.interpolate({
                          inputRange: [0, 0.536, 0.55, 1],
                          outputRange: [0, 0, 1, 1],
                        }),
                      },
                    ]}
                  >
                    <QuotePage theme={theme} />
                  </Animated.View>
                </Animated.View>

                <Animated.View
                  pointerEvents="none"
                  style={[
                    styles.bookGutter,
                    {
                      opacity: cameraProgress.interpolate({ inputRange: [0, 0.72, 1], outputRange: [0, 0, 1] }),
                    },
                  ]}
                >
                  {gutterShadowBands.map((backgroundColor) => (
                    <View key={backgroundColor} style={[styles.shadowBand, { backgroundColor }]} />
                  ))}
                </Animated.View>

              </Animated.View>
            </View>
          </KeyboardAvoidingView>
        </Animated.View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: { width: "100%", maxWidth: 760, alignSelf: "center", padding: 18 },
  panel: { marginTop: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14 },
  loadingRow: { minHeight: 64, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9 },
  statusText: { fontSize: 12, fontWeight: "700" },
  accountEntry: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: 11 },
  accountEntryText: { flex: 1, fontSize: 15, fontWeight: "800" },
  readerEntry: { alignItems: "center", paddingHorizontal: 8, paddingVertical: 30 },
  readerEntryStar: { fontSize: 28, lineHeight: 32 },
  readerEntryTitle: { marginTop: 7, fontSize: 27, fontWeight: "900", letterSpacing: 4 },
  readerEntryCopy: { marginTop: 13, textAlign: "center", fontSize: 11, lineHeight: 18, fontWeight: "700", letterSpacing: 0.5 },
  readerEntryActions: { width: "100%", maxWidth: 360, marginTop: 22, flexDirection: "row", gap: 10 },
  readerEntryButton: { flex: 1, minHeight: 46, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  readerEntryButtonPressed: { transform: [{ translateY: -2 }] },
  readerEntryButtonText: { fontSize: 13, fontWeight: "900", letterSpacing: 2 },
  infoRow: { minHeight: 62, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center" },
  infoLabel: { width: 84, fontSize: 11, fontWeight: "700" },
  infoValue: { flex: 1, textAlign: "right", fontSize: 14, fontWeight: "800" },
  signOutButton: { minHeight: 54, alignItems: "center", justifyContent: "center" },
  signOutText: { fontSize: 12, fontWeight: "900" },
  sectionGap: { marginTop: 26 },
  settingsRow: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: 11 },
  settingsText: { flex: 1, fontSize: 14, fontWeight: "800" },
  modalOverlay: { flex: 1 },
  dialogLayout: { flex: 1, alignItems: "center", justifyContent: "center" },
  bookViewport: { position: "relative" },
  openBook: { position: "absolute", top: 0, left: 0 },
  rightCover: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: "50%",
    width: "50%",
    borderWidth: 1,
    borderLeftWidth: 0,
    borderTopRightRadius: 15,
    borderBottomRightRadius: 15,
    paddingTop: 4,
    paddingRight: 5,
    paddingBottom: 6,
    elevation: 15,
  },
  leftPage: { position: "relative", flex: 1, overflow: "hidden", borderWidth: 1, borderRightWidth: 0, borderTopLeftRadius: 10, borderBottomLeftRadius: 10, padding: 22 },
  rightPage: { flex: 1, borderWidth: 1, borderLeftWidth: 0, borderTopRightRadius: 10, borderBottomRightRadius: 10, overflow: "hidden" },
  bookGutter: { position: "absolute", zIndex: 40, top: 4, bottom: 6, left: "50%", width: 14, flexDirection: "row", transform: [{ translateX: -7 }] },
  rightPageTurnShadow: { position: "absolute", zIndex: 3, top: 0, bottom: 0, left: 0, width: 64, flexDirection: "row", transformOrigin: "left center" },
  pageSpineShadow: { position: "absolute", zIndex: 3, top: 0, right: 0, bottom: 0, width: 48, flexDirection: "row" },
  shadowBand: { flex: 1 },
  dialogContent: { flexGrow: 1, paddingHorizontal: 20 },
  bookHeader: { minHeight: 60, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  bookHeaderText: { fontSize: 10, fontWeight: "900", letterSpacing: 2 },
  bookNumber: { fontSize: 10, fontWeight: "900", letterSpacing: 1.5 },
  modeTabs: { height: 43, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row" },
  modeTab: { flex: 1, borderBottomWidth: 2, borderBottomColor: "transparent", alignItems: "center", justifyContent: "center" },
  modeTabText: { fontSize: 12, fontWeight: "900", letterSpacing: 2 },
  form: { flexGrow: 1, justifyContent: "center", paddingVertical: 19 },
  fieldLabel: { marginBottom: 7, fontSize: 12, fontWeight: "800" },
  passwordLabel: { marginTop: 15 },
  input: { height: 46, borderBottomWidth: 1, paddingHorizontal: 3, fontSize: 14 },
  codeEntry: { position: "relative", height: 58 },
  codeSlots: { ...StyleSheet.absoluteFillObject, flexDirection: "row", gap: 6 },
  codeSlot: { flex: 1, alignItems: "center", justifyContent: "center", borderWidth: 1 },
  codeDigit: { fontSize: 22, fontWeight: "900", lineHeight: 26 },
  codeHiddenInput: { ...StyleSheet.absoluteFillObject, color: "transparent", backgroundColor: "transparent", opacity: 0.02 },
  error: { marginTop: 11, fontSize: 12, lineHeight: 18, fontWeight: "700" },
  loginButton: { height: 46, marginTop: 18, alignItems: "center", justifyContent: "center" },
  loginText: { fontSize: 13, fontWeight: "900" },
  textAction: { paddingVertical: 7, textAlign: "center", fontSize: 11, fontWeight: "900" },
  recoveryTitle: { fontSize: 22, fontWeight: "900", letterSpacing: 1.5 },
  confirmation: { flex: 1, minHeight: 230, justifyContent: "center", paddingVertical: 30 },
  confirmationTitle: { fontSize: 24, fontWeight: "900", letterSpacing: 2 },
  confirmationText: { marginTop: 13, fontSize: 12, lineHeight: 21, fontWeight: "700" },
  bookFooter: { minHeight: 42, marginTop: "auto", borderTopWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  bookFooterText: { fontSize: 9, fontWeight: "800", letterSpacing: 1.2 },
  quoteFrame: { flex: 1, borderWidth: 1, padding: 24, alignItems: "center", justifyContent: "center" },
  quoteStar: { marginBottom: 28, fontSize: 34, lineHeight: 38 },
  quoteBody: { width: "100%", maxWidth: 320, borderTopWidth: 1, borderBottomWidth: 1, paddingVertical: 20 },
  quoteLine: { fontSize: 15, lineHeight: 30, fontWeight: "900", letterSpacing: 0.5 },
  quoteAuthor: { marginTop: 13, textAlign: "right", fontSize: 11, fontWeight: "800" },
  quoteSource: { marginTop: 5, textAlign: "right", fontSize: 9, lineHeight: 14 },
  turningPage: {
    position: "absolute",
    zIndex: 30,
    top: 0,
    bottom: 0,
    left: "50%",
    width: "50%",
    // Keep the transformed leaf above the elevated book cover after it crosses
    // 90deg. Without elevation Android draws the landed back face underneath.
    elevation: 18,
    transformOrigin: "left center",
  },
  turningFace: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 1,
    borderTopLeftRadius: 11,
    borderBottomLeftRadius: 11,
    borderTopRightRadius: 15,
    borderBottomRightRadius: 15,
    overflow: "hidden",
    backfaceVisibility: "hidden",
  },
  turningFront: {
    alignItems: "center",
    justifyContent: "center",
  },
  turningBack: {
    paddingTop: 4,
    paddingBottom: 6,
    paddingLeft: 5,
    backfaceVisibility: "visible",
    // The outer leaf uses a negative X scale after crossing the spine. Mirror
    // its back once so the quote remains readable in the settled left page.
    transform: [{ scaleX: -1 }],
  },
  turningEdge: { position: "absolute", zIndex: 5, top: 3, right: -2, bottom: 3, width: 3 },
  coverFrame: { position: "absolute", top: 14, right: 14, bottom: 14, left: 14, borderWidth: StyleSheet.hairlineWidth, opacity: 0.42 },
  coverMotto: { position: "absolute", left: 10, width: 12, fontSize: 7, lineHeight: 11, opacity: 0.64 },
  coverStar: { marginBottom: 32, fontSize: 34 },
  coverTitle: { fontSize: 24, fontWeight: "900", letterSpacing: 7 },
});
