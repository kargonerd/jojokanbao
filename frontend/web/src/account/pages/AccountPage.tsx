import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useAuthStore } from "@/account/auth";
import { AccountBook, type AccountMode } from "@/account/components/AccountBook";
import { LoginForm, RegisterForm } from "@/account/components/AccountForms";
import { AccountCenterPage } from "@/account/pages/AccountCenterPage";

function safeReturnPath(value: string | null): string {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
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
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const [confirmationEmail, setConfirmationEmail] = useState<string | null>(null);
  const {
    user,
    signIn,
    signUp,
    busy,
    error,
    notice,
    clearFeedback,
  } = useAuthStore();

  if (user && hasReturnTo) return <Navigate to={returnTo} replace />;
  if (user) return <AccountCenterPage userId={user.id} />;

  const changeMode = (nextMode: AccountMode) => {
    clearFeedback();
    setRegistrationError(null);
    setMode(nextMode);
  };

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      await signIn(loginEmail.trim(), loginPassword);
      navigate(returnTo, { replace: true });
    } catch {
      // The shared auth store exposes a localized error.
    }
  };

  const handleRegistration = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setRegistrationError(null);

    const code = invitationCode.trim();
    const email = registrationEmail.trim();
    if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/i.test(code)) {
      setRegistrationError("请输入正确的 6 位邀请码。");
      return;
    }
    if (registrationPassword.length < 8) {
      setRegistrationError("密码至少需要 8 位字符。");
      return;
    }

    try {
      const requiresConfirmation = await signUp({
        invitationCode: code,
        email,
        password: registrationPassword,
        emailRedirectTo: hasReturnTo
          ? `${window.location.origin}/account?returnTo=${encodeURIComponent(returnTo)}`
          : `${window.location.origin}/account`,
      });
      if (requiresConfirmation) {
        setConfirmationEmail(email);
      } else {
        navigate(returnTo, { replace: true });
      }
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
          onSubmit={handleLogin}
        />
      ) : (
        <RegisterForm
          invitationCode={invitationCode}
          email={registrationEmail}
          password={registrationPassword}
          confirmationEmail={confirmationEmail}
          busy={busy}
          error={registrationError ?? error}
          notice={notice}
          onInvitationCodeChange={setInvitationCode}
          onEmailChange={setRegistrationEmail}
          onPasswordChange={setRegistrationPassword}
          onSubmit={handleRegistration}
        />
      )}
    </AccountBook>
  );
}
