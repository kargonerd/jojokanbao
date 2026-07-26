import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuthStore } from "@/account/auth";
import { LoginBook } from "@/account/components/LoginBook";

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
    <LoginBook
      email={email}
      password={password}
      busy={busy}
      error={error}
      notice={notice}
      onEmailChange={setEmail}
      onPasswordChange={setPassword}
      onSubmit={handleSubmit}
    />
  );
}
