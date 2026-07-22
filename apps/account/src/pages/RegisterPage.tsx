import { useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import { useAuthStore } from "@/auth";
import { AuthScaffold } from "@/components/AuthScaffold";
import { AuthField, FormFeedback, PasswordField, SubmitButton } from "@/components/FormParts";

export function RegisterPage() {
  const [invitationCode, setInvitationCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(false);
  const { user, signUp, busy, error, notice } = useAuthStore();

  if (user) return <Navigate to="/account" replace />;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setValidationError(null);
    if (!invitationCode.trim()) {
      setValidationError("请输入邀请码。");
      return;
    }
    if (password.length < 8) {
      setValidationError("密码至少需要 8 位字符。");
      return;
    }
    if (password !== confirmPassword) {
      setValidationError("两次输入的密码不一致。");
      return;
    }
    try {
      const requiresConfirmation = await signUp({
        invitationCode: invitationCode.trim(),
        displayName,
        email: email.trim(),
        password,
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      });
      setEmailSent(requiresConfirmation);
    } catch {
      // The shared auth store exposes a localized error.
    }
  };

  return (
    <AuthScaffold
      eyebrow="Registration / 登记"
      title={emailSent ? "检查你的邮箱" : "领取读者证"}
      description={emailSent ? `确认邮件已发送到 ${email}` : "注册仅对受邀用户开放，这个账号可用于未来接入的 JOJO 服务。"}
    >
      {emailSent ? (
        <div className="border-y border-rule py-8">
          <span className="mb-5 flex h-12 w-12 items-center justify-center border-2 border-red text-xl font-black text-red">✓</span>
          <FormFeedback notice={notice} />
          <p className="mt-5 text-sm leading-7 text-muted">
            邮件里的链接用于确认邮箱并激活账号。完成后会自动回到账号中心。
          </p>
          <Link to="/login" className="mt-7 inline-block text-sm font-bold">返回登录 →</Link>
        </div>
      ) : (
        <>
          <form className="space-y-5" onSubmit={handleSubmit}>
            <FormFeedback error={validationError ?? error} notice={notice} />
            <AuthField
              label="邀请码"
              name="invitationCode"
              autoComplete="off"
              placeholder="JOJO-XXXX-XXXX-XXXX"
              value={invitationCode}
              onChange={(event) => setInvitationCode(event.target.value)}
              required
            />
            <AuthField
              label="显示名称"
              name="displayName"
              autoComplete="nickname"
              placeholder="怎么称呼你"
              maxLength={50}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
            <AuthField
              label="邮箱"
              type="email"
              name="email"
              autoComplete="email"
              placeholder="name@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            <PasswordField
              label="设置密码"
              name="password"
              autoComplete="new-password"
              placeholder="至少 8 位字符"
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            <PasswordField
              label="再次输入密码"
              name="confirmPassword"
              autoComplete="new-password"
              placeholder="重复输入密码"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
            />
            <SubmitButton busy={busy}>创建账号</SubmitButton>
          </form>
          <div className="mt-8 border-t border-rule pt-5 text-sm text-muted">
            已经注册？ <Link to="/login" className="font-bold">返回登录</Link>
          </div>
        </>
      )}
    </AuthScaffold>
  );
}
