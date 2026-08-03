import { useState, type FormEvent } from "react";
import { resendSignupConfirmation } from "../auth";

export function ResendConfirmationForm() {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSending(true);
    setNotice(null);
    setError(null);

    try {
      await resendSignupConfirmation(email.trim());
      setNotice("新的确认邮件已经发出，请使用最新邮件中的链接。");
    } catch {
      setError("暂时无法发送确认邮件，请稍后再试。");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <form className="mt-8 border-t border-rule pt-7" onSubmit={resend}>
        <label className="block">
          <span className="mb-2 block text-sm font-bold tracking-[0.08em]">
            注册邮箱
          </span>
          <input
            type="email"
            value={email}
            required
            autoComplete="email"
            onChange={(event) => setEmail(event.target.value)}
            className="w-full border-0 border-b border-ink bg-transparent px-0 py-3 text-base text-ink outline-none transition-colors focus:border-red"
          />
        </label>
        <button
          type="submit"
          disabled={sending}
          className="mt-6 border border-red bg-red px-6 py-3 font-serif text-sm font-bold tracking-[0.1em] text-white transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-[4px_4px_0_rgba(139,26,26,.14)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red disabled:cursor-wait disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:shadow-none"
        >
          {sending ? "正在发送…" : "重新发送确认邮件"}
        </button>
      </form>

      {notice && (
        <p role="status" className="mt-6 border-l-2 border-red pl-4 text-sm leading-7 text-ink">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-6 border-l-2 border-red pl-4 text-sm leading-7 text-red">
          {error}
        </p>
      )}
    </>
  );
}
