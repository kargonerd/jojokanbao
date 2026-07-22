import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuthStore } from "@/auth";
import { AuthScaffold } from "@/components/AuthScaffold";
import { AuthField, FormFeedback, SubmitButton } from "@/components/FormParts";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const { sendPasswordReset, busy, error, notice } = useAuthStore();

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await sendPasswordReset(email.trim(), `${window.location.origin}/reset-password`);
    } catch {
      // The shared auth store exposes a localized error.
    }
  };

  return (
    <AuthScaffold eyebrow="Account recovery / 找回" title="重置密码" description="填写注册邮箱，我们会发送一封安全链接。">
      <form className="space-y-5" onSubmit={handleSubmit}>
        <FormFeedback error={error} notice={notice} />
        <AuthField
          label="注册邮箱"
          type="email"
          name="email"
          autoComplete="email"
          placeholder="name@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <SubmitButton busy={busy}>发送重置邮件</SubmitButton>
      </form>
      <div className="mt-8 border-t border-rule pt-5 text-sm">
        <Link to="/login" className="font-bold">← 返回登录</Link>
      </div>
    </AuthScaffold>
  );
}
