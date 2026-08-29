import { useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@jojo/ui";
import { AiExperimentalNotice } from "../components/AiBetaNotice";
import { ReferenceButtons } from "../components/ReferenceButtons";
import { useChatStore } from "../stores/chatStore";
import { formatChatMarkdown } from "../utils/markdown";

function conversationDate(timestamp?: number): string {
  if (!timestamp) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function readableChatError(error: string): string {
  if (error.includes("Trusted service authentication required")) {
    return "AI 服务版本不一致。请刷新页面后重新提问。";
  }
  if (error.includes("Authentication required") || error.includes("access token")) {
    return "登录状态已失效，请重新登录后提问。";
  }
  if (error.includes("is unavailable") || error.includes("问答服务")) {
    return "暂时无法连接 AI 服务，请稍后重新提问。";
  }
  return error.replace(/\bAgent\b/gi, "问答服务");
}

function ConversationHistory({ compact = false }: { compact?: boolean }) {
  const {
    conversations,
    conversationId,
    historyLoading,
    streaming,
    openConversation,
    deleteConversation,
    clearConversation,
  } = useChatStore();

  return (
    <section
      aria-label="历史对话"
      className={compact ? "p-3" : "flex h-full min-h-0 flex-col bg-[#f1f1ef]"}
    >
      <div className={compact
        ? "mb-3 flex items-center justify-between gap-3"
        : "border-b border-rule p-3"}
      >
        {compact ? <h2 className="m-0 font-sans text-xs font-bold text-ink">历史记录</h2> : null}
        <button
          type="button"
          onClick={clearConversation}
          disabled={streaming || historyLoading}
          className={compact
            ? "border-0 bg-transparent px-1 py-2 font-sans text-[11px] font-bold text-red hover:underline disabled:opacity-35"
            : "flex w-full items-center gap-2 border border-rule-dark bg-paper px-3 py-2.5 text-left font-sans text-xs font-bold text-ink transition-[border-color,color] hover:border-red hover:text-red disabled:opacity-35"}
        >
          <span aria-hidden="true" className={compact ? "hidden" : "text-base font-normal leading-none"}>＋</span>
          新对话
        </button>
      </div>
      <div className={compact
        ? "max-h-56 overflow-y-auto border-t border-rule"
        : "min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-4"}
      >
        {!compact ? <p className="mb-2 mt-0 px-3 font-sans text-[10px] font-bold text-muted">历史记录</p> : null}
        {historyLoading && !conversations.length ? (
          <p className="px-3 py-3 font-sans text-[11px] text-muted">正在读取历史…</p>
        ) : null}
        {!historyLoading && !conversations.length ? (
          <p className="px-3 py-4 font-sans text-[11px] text-muted">暂无历史记录</p>
        ) : null}
        {conversations.map((conversation) => {
          const active = conversation.id === conversationId;
          return (
            <article
              key={conversation.id}
              className={`group mb-1 grid grid-cols-[minmax(0,1fr)_28px] border-l-2 ${active ? "border-l-red bg-paper" : "border-l-transparent hover:bg-paper/70"}`}
            >
              <button
                type="button"
                disabled={streaming || historyLoading}
                onClick={() => void openConversation(conversation.id)}
                className="min-w-0 border-0 bg-transparent px-3 py-2.5 text-left disabled:cursor-default"
              >
                <span className={`block truncate font-sans text-xs font-medium leading-5 ${active ? "text-red" : "text-ink"}`}>
                  {conversation.title}
                </span>
                <span className="mt-0.5 block font-sans text-[9px] text-muted">
                  {conversationDate(conversation.lastMessageAt)} · {conversation.messageCount} 条
                </span>
              </button>
              <button
                type="button"
                aria-label={`删除对话：${conversation.title}`}
                disabled={streaming || historyLoading}
                onClick={() => {
                  if (window.confirm(`删除对话“${conversation.title}”？此操作无法撤销。`)) {
                    void deleteConversation(conversation.id);
                  }
                }}
                className="border-0 bg-transparent font-sans text-sm text-muted opacity-35 hover:text-red hover:opacity-100 focus:opacity-100"
              >
                ×
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ScopeSelector({ onClose }: { onClose?: () => void }) {
  const {
    notebooks,
    selectedNotebookIds,
    loading,
    streaming,
    selectNotebook,
    toggleNotebook,
  } = useChatStore();
  const [query, setQuery] = useState("");
  const visibleNotebooks = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return notebooks;
    return notebooks.filter((notebook) => (
      notebook.title || notebook.name || ""
    ).toLocaleLowerCase("zh-CN").includes(normalized));
  }, [notebooks, query]);

  return (
    <section aria-label="提问范围" className="p-4">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h2 className="m-0 text-sm font-bold text-ink">选择书籍</h2>
          <p className="mb-0 mt-1.5 font-sans text-[11px] leading-5 text-muted">不选时查询全部书籍，可以多选。</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 border-0 bg-transparent px-1 py-0.5 font-sans text-[11px] font-bold text-red hover:underline focus-visible:outline-2 focus-visible:outline-red"
        >
          完成
        </button>
      </div>
      <label className="block">
        <span className="sr-only">筛选书目</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="输入书名筛选"
          className="w-full border border-rule-dark bg-paper px-3 py-2 text-xs shadow-none focus:border-red focus:outline-none"
        />
      </label>

      <div className="mt-3 max-h-44 overflow-y-auto border-t border-rule pt-2">
        <button
          type="button"
          aria-pressed={selectedNotebookIds.length === 0}
          disabled={streaming}
          onClick={() => selectNotebook(null)}
          className={`group mb-1 grid w-full grid-cols-[18px_minmax(0,1fr)] items-start gap-2 border-0 border-l-2 px-3 py-2.5 text-left transition-colors ${selectedNotebookIds.length === 0 ? "border-red bg-red/5 text-red" : "border-transparent bg-transparent text-ink hover:border-rule hover:bg-[#f5f4f1]"}`}
        >
          <span
            aria-hidden="true"
            className={`mt-0.5 grid h-[14px] w-[14px] place-items-center border text-[9px] leading-none ${selectedNotebookIds.length === 0 ? "border-red bg-red text-white" : "border-[#aaa7a0] text-transparent group-hover:border-red"}`}
          >
            {selectedNotebookIds.length === 0 ? "✓" : "·"}
          </span>
          <span>
            <strong className="block text-xs leading-5">全部书籍</strong>
            <small className="mt-0.5 block font-sans text-[9px] font-normal text-muted">默认范围</small>
          </span>
        </button>
        {loading ? <p className="px-2 text-xs text-muted">正在加载…</p> : null}
        {!loading && visibleNotebooks.length === 0 ? (
          <p className="px-3 py-3 text-xs leading-5 text-muted">没有匹配的书籍。</p>
        ) : null}
        {visibleNotebooks.map((notebook) => {
          const selected = selectedNotebookIds.includes(notebook.id);
          const title = notebook.title || notebook.name || "未命名书目";
          return (
            <button
              key={notebook.id}
              type="button"
              aria-pressed={selected}
              disabled={streaming}
              onClick={() => toggleNotebook(notebook.id)}
              className={`group mb-1 grid w-full grid-cols-[18px_minmax(0,1fr)] items-start gap-2 border-0 border-l-2 px-3 py-2.5 text-left transition-colors ${selected ? "border-red bg-red/5 text-red" : "border-transparent bg-transparent text-ink hover:border-rule hover:bg-[#f5f4f1]"}`}
            >
              <span
                aria-hidden="true"
                className={`mt-0.5 grid h-[14px] w-[14px] place-items-center border text-[9px] leading-none ${selected ? "border-red bg-red text-white" : "border-[#aaa7a0] text-transparent group-hover:border-red"}`}
              >
                {selected ? "✓" : "·"}
              </span>
              <span className="text-xs font-bold leading-5">{title}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

const assistantTextClass = [
  "text-[15px] leading-8 text-ink",
  "[&_a]:font-bold [&_a]:text-red",
  "[&_blockquote]:my-4 [&_blockquote]:border-l [&_blockquote]:border-rule-dark [&_blockquote]:pl-4",
  "[&_h1]:mb-3 [&_h1]:mt-6 [&_h1]:text-xl",
  "[&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-lg",
  "[&_li]:my-1 [&_ol]:my-4 [&_ul]:my-4",
  "[&_p]:my-3 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
  "[&_strong]:text-red",
].join(" ");

export function ChatPage() {
  const {
    notebooks,
    selectedNotebookIds,
    messages,
    conversationId,
    loading,
    historyLoading,
    error,
    streaming,
    streamContent,
    streamStatus,
    loadNotebooks,
    sendMessage,
    clearConversation,
  } = useChatStore();
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scopeDetailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => { void loadNotebooks(); }, [loadNotebooks]);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamContent, streamStatus]);

  const selectedTitles = selectedNotebookIds.map((id) => {
    const notebook = notebooks.find((candidate) => candidate.id === id);
    return notebook?.title || notebook?.name || "";
  }).filter(Boolean);
  const scopeLabel = selectedTitles.length === 0
    ? "全部书籍"
    : selectedTitles.length === 1
      ? `仅《${selectedTitles[0]}》`
      : `限定 ${selectedTitles.length} 本书`;
  const canSend = Boolean(input.trim() && notebooks.length && !loading && !historyLoading && !streaming);
  const hasThread = Boolean(conversationId) || messages.length > 0 || streaming || Boolean(error);
  const handleSend = () => {
    if (!canSend) return;
    sendMessage(input);
    setInput("");
  };

  const renderComposer = (prominent: boolean) => (
    <form
      aria-label="提问"
      onSubmit={(event) => {
        event.preventDefault();
        handleSend();
      }}
      className={`w-full border border-rule-dark bg-paper transition-[border-color,box-shadow] focus-within:border-red ${prominent ? "shadow-[6px_6px_0_rgba(139,26,26,.10)]" : "shadow-[4px_4px_0_rgba(32,32,32,.06)]"}`}
    >
      <div className={`flex items-end gap-3 px-4 ${prominent ? "pb-4 pt-5 md:px-5" : "pb-3 pt-4"}`}>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              handleSend();
            }
          }}
          autoFocus={prominent}
          aria-label="输入问题"
          placeholder="输入问题"
          rows={prominent ? 2 : 1}
          className={`max-h-[160px] flex-1 resize-none border-0 bg-transparent p-0 text-[15px] leading-7 shadow-none outline-none placeholder:text-[#8a8882] focus:border-0 focus:shadow-none ${prominent ? "min-h-14" : "min-h-7"}`}
        />
        <button
          type="submit"
          disabled={!canSend}
          className="mb-0.5 h-10 shrink-0 border border-red bg-red px-5 font-sans text-xs font-bold text-white transition-[transform,box-shadow] hover:-translate-y-0.5 hover:shadow-[3px_3px_0_rgba(139,26,26,.16)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red disabled:translate-y-0 disabled:border-rule disabled:bg-[#deddd9] disabled:text-muted disabled:shadow-none"
        >
          发送
        </button>
      </div>
      <div className="flex min-h-10 items-center justify-between gap-3 border-t border-rule px-3 font-sans">
        <details ref={scopeDetailsRef} className="group relative">
          <summary
            aria-label={`选择书籍，当前${scopeLabel}`}
            className="cursor-pointer list-none px-1 py-2 text-[10px] font-bold text-red hover:underline focus-visible:outline-2 focus-visible:outline-red"
          >
            {scopeLabel} <span aria-hidden="true" className="ml-1 inline-block transition-transform group-open:rotate-180">⌃</span>
          </summary>
          <div className={`absolute left-0 z-30 w-[min(24rem,calc(100vw-2rem))] border border-rule bg-paper shadow-[4px_4px_0_rgba(139,26,26,.14)] ${prominent ? "top-[calc(100%+8px)]" : "bottom-[calc(100%+8px)]"}`}>
            <ScopeSelector onClose={() => scopeDetailsRef.current?.removeAttribute("open")} />
          </div>
        </details>
        <span className="hidden truncate text-[9px] text-muted sm:block">Enter 发送 · Shift + Enter 换行</span>
      </div>
    </form>
  );

  return (
    <AppShell
      className="!h-[calc(100vh-64px)] !bg-[var(--app-canvas)]"
      sidebar={<ConversationHistory />}
      sidebarClassName="!hidden md:!block md:w-[15rem] !p-0 !overflow-hidden"
      contentClassName="flex flex-col !overflow-hidden"
    >
      <details className="shrink-0 border-b border-rule bg-paper md:hidden">
        <summary className="cursor-pointer list-none px-4 py-3 font-sans text-[11px] font-bold tracking-[.08em] text-red">
          历史对话 · {messages.length ? "当前对话" : "新对话"}
        </summary>
        <ConversationHistory compact />
      </details>

      <AiExperimentalNotice className="shrink-0 border-b border-rule px-4 md:px-5" />

      <div className="flex min-h-0 flex-1 flex-col bg-[var(--app-canvas)]">
        {!hasThread ? (
          <section aria-label="开始提问" className="flex min-h-0 flex-1 items-center px-5 pb-[10vh] pt-8 md:px-8">
            <h1 className="sr-only">馆藏问答</h1>
            <div className="mx-auto w-full max-w-[48rem]">
              {loading ? (
                <p className="m-0 text-center font-sans text-xs text-muted">正在加载书籍…</p>
              ) : historyLoading ? (
                <p className="m-0 text-center font-sans text-xs text-muted">正在加载历史记录…</p>
              ) : renderComposer(true)}
            </div>
          </section>
        ) : (
          <>
            <div role="log" aria-live="polite" className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto flex min-h-full w-full max-w-[52rem] flex-col px-5 py-8 md:px-8 md:py-12">
                <h1 className="sr-only">馆藏问答</h1>
                {historyLoading && !messages.length ? (
                  <div className="flex flex-1 items-center justify-center pb-[10vh] font-sans text-xs text-muted">
                    <span aria-hidden="true" className="mr-3 inline-block h-2 w-2 bg-red motion-safe:animate-pulse" />
                    正在加载对话…
                  </div>
                ) : null}
                <div className="space-y-9">
              {messages.map((message, index) => (
                message.role === "user" ? (
                  <article
                    key={message.id ?? index}
                    className="ml-auto w-fit max-w-[min(82%,40rem)] border border-rule bg-[#e9e9e6] px-4 py-3 md:px-5"
                  >
                    <p className="m-0 whitespace-pre-wrap text-sm leading-7 text-ink md:text-[15px]">{message.content}</p>
                  </article>
                ) : (
                  <article key={message.id ?? index} className="max-w-[47rem] border-l-2 border-red pl-5 md:pl-7">
                    <div
                      className={assistantTextClass}
                      dangerouslySetInnerHTML={{ __html: formatChatMarkdown(message.content, message.references) }}
                    />
                    <ReferenceButtons content={message.content} references={message.references} />
                  </article>
                )
              ))}

              {streaming ? (
                <article className="max-w-[47rem] border-l-2 border-red pl-5 md:pl-7">
                  <p className="mb-3 mt-0 font-sans text-[10px] font-bold text-red">
                    {streamContent ? "正在回答" : "正在查找"}
                  </p>
                  <div role="status" className={`flex items-center gap-3 font-sans text-xs text-muted ${streamContent ? "mb-4" : ""}`}>
                    <span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 bg-red motion-safe:animate-pulse" />
                    <span>{streamStatus || "正在分析问题并选择资料…"}</span>
                  </div>
                  {streamContent ? (
                    <div
                      className={assistantTextClass}
                      dangerouslySetInnerHTML={{ __html: formatChatMarkdown(streamContent) }}
                    />
                  ) : null}
                </article>
              ) : null}

              {error ? (
                <article role="alert" className="max-w-[47rem] border-l-2 border-red bg-[#f3e9e7] px-5 py-3 md:px-7">
                  <p className="mb-1.5 mt-0 font-sans text-[10px] font-bold text-red">回答中断</p>
                  <p className="m-0 font-sans text-xs leading-6 text-ink">{readableChatError(error)}</p>
                </article>
              ) : null}
                </div>
                <div ref={messagesEndRef} />
              </div>
            </div>

            <footer className="shrink-0 px-4 pb-4 pt-2 md:px-8 md:pb-6">
              <div className="mx-auto max-w-[48rem]">{renderComposer(false)}</div>
            </footer>
          </>
        )}
      </div>
    </AppShell>
  );
}
