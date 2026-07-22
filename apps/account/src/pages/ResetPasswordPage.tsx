import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuthStore } from "@/auth";
import { AuthScaffold } from "@/components/AuthScaffold";
import { FormFeedback, PasswordField, SubmitButton } from "@/components/FormParts";
import { LoadingPage } from "@/components/LoadingPage";

export function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const { initialized, user, updatePassword, busy, error, notice } = useAuthStore();

  if (!initialized) return <LoadingPage label="正在验证重置链接…" />;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setValidationError(null);
    if (password.length < 8) {
      setValidationError("密码至少需要 8 位字符。");
      return;
    }
    if (password !== confirmPassword) {
      setValidationError("两次输入的密码不一致。");
      return;
    }
    try {
      await updatePassword(password);
      setPassword("");
      setConfirmPassword("");
    } catch {
      // The shared auth store exposes a localized error.
    }
  };

  return (
    <AuthScaffold eyebrow="New password / 新密码" title="设置新密码" description="密码更新后，所有 JOJO 服务都使用这组新密码。">
      {!user ? (
        <div className="border-l-4 border-red bg-red/5 p-5">
          <h3 className="font-bold text-red-dark">重置链接无效或已经过期</h3>
          <p className="mt-2 text-sm leading-6 text-muted">请重新申请一封密码重置邮件。</p>
          <Link to="/forgot-password" className="mt-5 inline-block text-sm font-bold">重新申请 →</Link>
        </div>
      ) : (
        <form className="space-y-5" onSubmit={handleSubmit}>
          <FormFeedback error={validationError ?? error} notice={notice} />
          <PasswordField
            label="新密码"
            name="password"
            autoComplete="new-password"
            placeholder="至少 8 位字符"
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          <PasswordField
            label="再次输入新密码"
            name="confirmPassword"
            autoComplete="new-password"
            placeholder="重复输入密码"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            required
          />
          <SubmitButton busy={busy}>保存新密码</SubmitButton>
          {notice ? <Link to="/account" className="inline-block text-sm font-bold">返回账号中心 →</Link> : null}
        </form>
      )}
    </AuthScaffold>
  );
}
