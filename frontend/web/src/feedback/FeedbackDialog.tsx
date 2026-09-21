import { Modal } from "@jojo/ui";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { submitFeedback, type FeedbackTopic } from "@jojo/analytics/feedback";

export interface FeedbackCorrection {
  quote: string;
  contentType: "book" | "periodical" | "times_article";
  contentId?: string;
  contentTitle?: string;
  section?: string;
}

const TOPIC_OPTIONS: Array<{ value: Exclude<FeedbackTopic, "content_correction">; label: string }> = [
  { value: "bug", label: "功能异常" },
  { value: "suggestion", label: "功能建议" },
  { value: "other", label: "其他" },
];

const primaryButtonClass =
  "min-h-11 border border-red bg-red px-5 font-serif text-sm font-black tracking-[0.08em] text-white transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-[4px_4px_0_rgba(139,26,26,.14)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red disabled:cursor-wait disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:shadow-none";

const secondaryButtonClass =
  "min-h-11 border border-rule-dark bg-paper px-5 font-serif text-sm font-black tracking-[0.08em] text-ink hover:border-red hover:text-red focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red disabled:cursor-wait disabled:opacity-60";

const topicChoiceClass = (active: boolean) =>
  `min-h-10 border px-3 font-serif text-xs font-black tracking-[0.06em] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red ${active ? "border-red bg-red text-white" : "border-rule-dark bg-paper text-ink hover:border-red hover:text-red"}`;

export function FeedbackDialog({ open, onClose, correction, screen }: {
  open: boolean;
  onClose: () => void;
  /** Present in correction mode; the topic is fixed and the quote is shown read-only. */
  correction?: FeedbackCorrection;
  screen?: string;
}) {
  const [topic, setTopic] = useState<Exclude<FeedbackTopic, "content_correction">>("bug");
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const reset = () => {
    setMessage("");
    setNotice("");
    setSending(false);
  };

  const close = () => {
    if (sending) return;
    clearTimeout(closeTimer.current);
    setSent(false);
    reset();
    onClose();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (sending || !message.trim()) return;
    setNotice("");
    setSending(true);
    const trimmed = message.trim();
    const outcome = submitFeedback(correction
      ? { topic: "content_correction", message: trimmed, ...correction, screen }
      : { topic, message: trimmed, screen });
    setSending(false);
    if (outcome === "sent") {
      reset();
      setSent(true);
      closeTimer.current = setTimeout(close, 1_400);
    } else if (outcome === "unavailable") {
      setNotice("使用统计未开启或尚未就绪，暂时无法提交反馈。");
    } else {
      setNotice("反馈内容为空或过长，请调整后重试。");
    }
  };

  return (
    <Modal open={open} onClose={close} size="medium" surface="bare">
      <section role="dialog" aria-modal="true" aria-labelledby="feedback-dialog-title" className="mx-auto w-full max-w-[30rem] border border-rule-dark border-t-4 border-t-red bg-paper p-6 shadow-[8px_10px_36px_rgba(32,32,32,.18)] sm:p-8">
        <div className="flex items-start justify-between gap-5 border-b border-rule pb-4">
          <div>
            <h2 id="feedback-dialog-title" className="m-0 font-serif text-2xl font-black text-ink">{correction ? "内容纠错" : "问题反馈"}</h2>
            <p className="mb-0 mt-2 text-xs font-bold leading-6 text-muted">
              {correction ? "选中内容会随反馈一起提交，帮助我们定位原文。" : "遇到问题或有好想法，都可以写给我们。"}
            </p>
          </div>
          <button type="button" aria-label={correction ? "关闭内容纠错" : "关闭问题反馈"} disabled={sending} onClick={close} className="flex h-8 w-8 shrink-0 items-center justify-center border border-rule-dark bg-paper text-xl leading-none text-muted hover:border-red hover:text-red focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red">×</button>
        </div>

        {notice ? <p role="alert" className="mb-0 mt-5 border-l-4 border-red bg-[#fbf3f3] px-4 py-3 text-sm font-bold leading-6 text-red">{notice}</p> : null}

        {sent ? (
          <p role="status" className="mb-0 mt-6 flex min-h-[240px] items-center justify-center border-l-4 border-ink bg-[#f5f3ee] px-4 py-3 font-serif text-sm leading-7 text-ink">已提交，感谢你的反馈。</p>
        ) : <>
        {correction ? (
          <blockquote className="mb-0 mt-5 max-h-40 overflow-y-auto border-l-2 border-red px-3 py-1 font-serif text-sm leading-8 text-muted">
            {correction.quote.length > 600 ? `${correction.quote.slice(0, 600)}…` : correction.quote}
          </blockquote>
        ) : null}

        <form className="mt-6 grid gap-4" onSubmit={submit}>
          {correction ? null : (
            <fieldset className="grid gap-2">
              <legend className="font-sans text-xs font-bold text-ink">反馈类型</legend>
              <div className="flex flex-wrap gap-2">
                {TOPIC_OPTIONS.map((option) => (
                  <button key={option.value} type="button" aria-pressed={topic === option.value} onClick={() => setTopic(option.value)} className={topicChoiceClass(topic === option.value)}>{option.label}</button>
                ))}
              </div>
            </fieldset>
          )}
          <label className="grid gap-2 font-sans text-xs font-bold text-ink">
            <span className="flex items-baseline justify-between gap-3">
              <span>{correction ? "问题说明" : "反馈内容"}</span>
              <span className="font-normal text-muted">{message.length}/2000</span>
            </span>
            <textarea
              aria-label={correction ? "问题说明" : "反馈内容"}
              autoFocus
              value={message}
              maxLength={2000}
              rows={5}
              disabled={sending}
              required
              onChange={(event) => setMessage(event.target.value)}
              placeholder={correction ? "说明这里的问题，例如正确的文字……" : "写下你遇到的问题或建议……"}
              className="block max-h-40 w-full resize-y border-0 border-b border-rule bg-transparent py-2 font-serif text-base leading-7 text-ink outline-none placeholder:text-muted focus:border-red disabled:opacity-60"
            />
          </label>
          <div className="mt-2 flex justify-end gap-3 border-t border-rule pt-5">
            <button type="button" disabled={sending} onClick={close} className={secondaryButtonClass}>取消</button>
            <button type="submit" disabled={sending || !message.trim()} className={primaryButtonClass}>{sending ? "提交中…" : "提交反馈"}</button>
          </div>
        </form>
        </>}
      </section>
    </Modal>
  );
}
