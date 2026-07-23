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
    <AuthScaffold eyebrow="读者登记" title="账号登录" description="请填写已经登记的邮箱和密码。">
      <form className="auth-form" onSubmit={handleSubmit}>
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
        <SubmitButton busy={busy}>登录并进入</SubmitButton>
      </form>
    </AuthScaffold>
  );
}
