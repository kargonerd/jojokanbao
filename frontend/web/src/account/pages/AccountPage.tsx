import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useAuthStore } from "../auth";
import { AccountBook, type AccountMode } from "../components/AccountBook";
import {
  LoginForm,
  RecoveryForm,
  RegisterForm,
  type RecoveryStep,
} from "../components/AccountForms";
import { AccountCenterPage } from "./AccountCenterPage";

function safeReturnPath(value: string | null): string {
  if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\r\n]/.test(value)) return "/";
  return /^\/account(?:[?#]|$)/.test(value) ? "/" : value;
}

export function AccountPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedReturnTo = searchParams.get("returnTo");
  const hasReturnTo = requestedReturnTo !== null;
  const returnTo = safeReturnPath(requestedReturnTo);
  const [mode, setMode] = useState<AccountMode>("login");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [invitationCode, setInvitationCode] = useState("");
  const [registrationEmail, setRegistrationEmail] = useState("");
  const [registrationPassword, setRegistrationPassword] = useState("");
  const [registrationPasswordConfirmation, setRegistrationPasswordConfirmation] = useState("");
  const [confirmationEmail, setConfirmationEmail] = useState<string | null>(null);
  const [confirmationCode, setConfirmationCode] = useState("");
  const [recoveryStep, setRecoveryStep] = useState<RecoveryStep>("email");
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [recoveryPasswordConfirmation, setRecoveryPasswordConfirmation] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [authTransitioning, setAuthTransitioning] = useState(false);
  const {
    user,
    signIn,
    signUp,
    confirmSignUp,
    resendSignUpCode,
    sendPasswordReset,
    verifyPasswordResetCode,
    completePasswordRecovery,
    busy,
    error,
    notice,
    clearFeedback,
  } = useAuthStore();

  useEffect(() => {
    if (resendSeconds <= 0) return undefined;
    const timer = window.setInterval(() => {
      setResendSeconds((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendSeconds]);

  if (user && mode !== "recover" && !authTransitioning && hasReturnTo) return <Navigate to={returnTo} replace />;
  if (user && mode !== "recover" && !authTransitioning) return <AccountCenterPage userId={user.id} />;

  const changeMode = (nextMode: AccountMode) => {
    clearFeedback();
    setLocalError(null);
    setMode(nextMode);
    if (nextMode === "recover") {
      setRecoveryStep("email");
      setRecoveryEmail(loginEmail.trim());
      setRecoveryCode("");
    }
  };

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthTransitioning(true);
    try {
      await signIn(loginEmail.trim(), loginPassword);
      navigate(returnTo, { replace: true });
    } catch {
      setAuthTransitioning(false);
      // The shared auth store exposes a localized error.
    }
  };

  const handleRegistration = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLocalError(null);
    const code = invitationCode.trim();
    const email = registrationEmail.trim();
    if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/i.test(code)) {
      setLocalError("请输入正确的 6 位邀请码。");
      return;
    }
    if (registrationPassword.length < 8) {
      setLocalError("密码至少需要 8 位字符。");
      return;
    }
    if (registrationPassword !== registrationPasswordConfirmation) {
      setLocalError("两次输入的密码不一致。");
      return;
    }

    try {
      setAuthTransitioning(true);
      const requiresConfirmation = await signUp({
        invitationCode: code,
        email,
        password: registrationPassword,
      });
      if (requiresConfirmation) {
        setAuthTransitioning(false);
        setConfirmationEmail(email);
        setConfirmationCode("");
        setResendSeconds(60);
      } else {
        navigate(returnTo, { replace: true });
      }
    } catch {
      setAuthTransitioning(false);
      // The shared auth store exposes a localized error.
    }
  };

  const handleRegistrationConfirmation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLocalError(null);
    if (!confirmationEmail || !/^\d{6}$/.test(confirmationCode)) {
      setLocalError("请输入邮件中的 6 位验证码。");
      return;
    }
    setAuthTransitioning(true);
    try {
      await confirmSignUp(confirmationEmail, confirmationCode);
      navigate(returnTo, { replace: true });
    } catch {
      setAuthTransitioning(false);
      // The shared auth store exposes a localized error.
    }
  };

  const resendRegistrationCode = async () => {
    if (!confirmationEmail || resendSeconds > 0) return;
    try {
      await resendSignUpCode(confirmationEmail);
      setResendSeconds(60);
    } catch {
      // The shared auth store exposes a localized error.
    }
  };

  const handleRecovery = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLocalError(null);
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
      setLoginEmail(recoveryEmail.trim());
      setLoginPassword("");
      setMode("login");
      if (hasReturnTo) navigate(returnTo, { replace: true });
    } catch {
      // The shared auth store exposes a localized error.
    }
  };

  const resendRecoveryCode = async () => {
    if (resendSeconds > 0) return;
    try {
      await sendPasswordReset(recoveryEmail.trim());
      setResendSeconds(60);
    } catch {
      // The shared auth store exposes a localized error.
    }
  };

  return (
    <AccountBook mode={mode} busy={busy} onModeChange={changeMode}>
      {mode === "login" ? (
        <LoginForm
          email={loginEmail}
          password={loginPassword}
          busy={busy}
          error={error}
          notice={notice}
          onEmailChange={setLoginEmail}
          onPasswordChange={setLoginPassword}
          onForgotPassword={() => changeMode("recover")}
          onSubmit={handleLogin}
        />
      ) : mode === "register" ? (
        <RegisterForm
          invitationCode={invitationCode}
          email={registrationEmail}
          password={registrationPassword}
          passwordConfirmation={registrationPasswordConfirmation}
          confirmationEmail={confirmationEmail}
          confirmationCode={confirmationCode}
          resendSeconds={resendSeconds}
          busy={busy}
          error={localError ?? error}
          notice={notice}
          onInvitationCodeChange={setInvitationCode}
          onEmailChange={setRegistrationEmail}
          onPasswordChange={setRegistrationPassword}
          onPasswordConfirmationChange={setRegistrationPasswordConfirmation}
          onConfirmationCodeChange={setConfirmationCode}
          onConfirmSubmit={handleRegistrationConfirmation}
          onResend={() => void resendRegistrationCode()}
          onEditRegistration={() => {
            clearFeedback();
            setLocalError(null);
            setConfirmationEmail(null);
            setConfirmationCode("");
          }}
          onSubmit={handleRegistration}
        />
      ) : (
        <RecoveryForm
          step={recoveryStep}
          email={recoveryEmail}
          code={recoveryCode}
          password={recoveryPassword}
          passwordConfirmation={recoveryPasswordConfirmation}
          resendSeconds={resendSeconds}
          busy={busy}
          error={localError ?? error}
          notice={notice}
          onEmailChange={setRecoveryEmail}
          onCodeChange={setRecoveryCode}
          onPasswordChange={setRecoveryPassword}
          onPasswordConfirmationChange={setRecoveryPasswordConfirmation}
          onResend={() => void resendRecoveryCode()}
          onBackToLogin={() => changeMode("login")}
          onSubmit={handleRecovery}
        />
      )}
    </AccountBook>
  );
}
