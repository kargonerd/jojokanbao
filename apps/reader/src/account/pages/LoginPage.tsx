import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuthStore } from "@/account/auth";
import { AuthScaffold } from "@/account/components/AuthScaffold";
import { AuthField, FormFeedback, PasswordField, SubmitButton } from "@/account/components/FormParts";

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { user, signIn, busy, error, notice } = useAuthStore();

  if (user) return <Navigate to="/" replace />;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await signIn(email.trim(), password);
      navigate("/", { replace: true });
    } catch {
      // The shared auth store exposes a localized error.
    }
  };

  return (
    <AuthScaffold eyebrow="Sign in / 登录" title="欢迎回来" description="使用你的 JOJO 账号继续阅读。">
      <form className="space-y-5" onSubmit={handleSubmit}>
        <FormFeedback error={error} notice={notice} />
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
          label="密码"
          name="password"
          autoComplete="current-password"
          placeholder="输入密码"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        <SubmitButton busy={busy}>登录账号</SubmitButton>
      </form>
      <div className="mt-8 border-t border-rule pt-5 text-sm text-muted">
        账号注册暂未开放，已有账号可以直接登录。
      </div>
    </AuthScaffold>
  );
}
