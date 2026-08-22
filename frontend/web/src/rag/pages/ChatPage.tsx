import { useEffect, useMemo, useRef, useState } from "react";
import { AppShell, Button } from "@jojo/ui";
import { useChatStore, type ChatScopeMode } from "../stores/chatStore";
import { formatChatMarkdown } from "../utils/markdown";

function ScopeSelector({ compact = false }: { compact?: boolean }) {
  const {
    notebooks,
    selectedNotebookIds,
    scopeMode,
    loading,
    streaming,
    selectNotebook,
    toggleNotebook,
    setScopeMode,
  } = useChatStore();
  const [query, setQuery] = useState("");
  const visibleNotebooks = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return notebooks;
    return notebooks.filter((notebook) => (
      notebook.title || notebook.name || ""
    ).toLocaleLowerCase("zh-CN").includes(normalized));
  }, [notebooks, query]);

  const chooseMode = (mode: ChatScopeMode) => {
    if (!streaming) setScopeMode(mode);
  };

  return (
    <section aria-label="提问范围" className={compact ? "p-3" : "flex h-full min-h-0 flex-col"}>
      <div className={compact ? "" : "border-b border-rule p-4"}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="m-0 text-sm font-bold tracking-[.12em] text-ink">提问范围</h2>
          <span className="border-l-2 border-red pl-2 text-[11px] font-bold text-red">已选 {selectedNotebookIds.length} 本</span>
        </div>
        <div className="grid grid-cols-2 border border-rule" aria-label="选择方式">
          {(["single", "multiple"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={scopeMode === mode}
              disabled={streaming}
              onClick={() => chooseMode(mode)}
              className={`border-0 px-3 py-2 text-xs font-bold transition-colors ${mode === "multiple" ? "border-l border-rule" : ""} ${scopeMode === mode ? "bg-red text-white" : "bg-paper text-muted hover:text-red"}`}
            >
              {mode === "single" ? "单本" : "多本"}
            </button>
          ))}
        </div>
        <label className="mt-3 block">
          <span className="sr-only">筛选书目</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="筛选书目"
            className="w-full border border-rule bg-paper px-3 py-2 text-xs shadow-none focus:border-red focus:outline-none"
          />
        </label>
      </div>

      <div className={compact ? "mt-3 max-h-64 overflow-y-auto border-t border-rule pt-2" : "min-h-0 flex-1 overflow-y-auto p-2"}>
        {loading ? <p className="px-2 text-xs text-muted">正在加载…</p> : null}
        {!loading && visibleNotebooks.length === 0 ? <p className="px-2 text-xs text-muted">没有匹配的书目</p> : null}
        {visibleNotebooks.map((notebook) => {
          const selected = selectedNotebookIds.includes(notebook.id);
          const title = notebook.title || notebook.name || "未命名书目";
          return (
            <button
              key={notebook.id}
              type="button"
              aria-pressed={selected}
              disabled={streaming}
              onClick={() => scopeMode === "single" ? selectNotebook(notebook.id) : toggleNotebook(notebook.id)}
              className={`group mb-1 grid w-full grid-cols-[18px_minmax(0,1fr)] items-start gap-2 border-0 border-l-2 px-3 py-2.5 text-left transition-colors ${selected ? "border-red bg-red/5 text-red" : "border-transparent bg-transparent text-ink hover:border-rule hover:bg-paper"}`}
            >
              <span aria-hidden="true" className={`mt-0.5 grid h-[14px] w-[14px] place-items-center border text-[9px] leading-none ${selected ? "border-red bg-red text-white" : "border-[#aaa7a0] text-transparent group-hover:border-red"}`}>
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

export function ChatPage() {
  const {
    notebooks,
    selectedNotebookIds,
    messages,
    loading,
    error,
    streaming,
    streamContent,
    loadNotebooks,
    sendMessage,
    clearConversation,
  } = useChatStore();
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => { void loadNotebooks(); }, [loadNotebooks]);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, streamContent]);

  const selectedTitles = selectedNotebookIds.map((id) => {
    const notebook = notebooks.find((candidate) => candidate.id === id);
    return notebook?.title || notebook?.name || "";
  }).filter(Boolean);
  const scopeLabel = selectedTitles.length === 1 ? `《${selectedTitles[0]}》` : `已选 ${selectedTitles.length} 本书`;
  const canSend = Boolean(input.trim() && selectedNotebookIds.length && !streaming);
  const handleSend = () => {
    if (!canSend) return;
    sendMessage(input);
    setInput("");
  };

  return (
    <AppShell
      className="!h-[calc(100vh-64px)] !bg-[var(--app-canvas)]"
      sidebar={<ScopeSelector />}
      sidebarClassName="hidden md:block w-72 !p-0"
      contentClassName="flex flex-col"
    >
      <details className="shrink-0 border-b border-rule bg-paper md:hidden">
        <summary className="cursor-pointer list-none px-4 py-3 text-xs font-bold text-red">提问范围 · {selectedNotebookIds.length ? scopeLabel : "未选择"}</summary>
        <ScopeSelector compact />
      </details>

      <div className="min-h-0 flex-1 flex flex-col">
        {messages.length > 0 ? (
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-rule px-4">
            <span className="truncate text-xs font-bold text-muted">{scopeLabel}</span>
            <button onClick={clearConversation} className="border-0 bg-transparent text-xs font-bold text-muted hover:text-red">清空</button>
          </div>
        ) : null}

        <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
          {error ? <div role="alert" className="border-l-4 border-red bg-red/5 px-4 py-3 text-sm text-red">{error}</div> : null}
          {messages.length === 0 && !streaming && !loading ? (
            <div className="grid h-full place-items-center">
              <span className="max-w-md border-l-2 border-red pl-3 text-sm font-bold text-muted">{selectedNotebookIds.length ? scopeLabel : "从左侧选择书目"}</span>
            </div>
          ) : null}
          {messages.map((message, index) => (
            <div key={index} className={`max-w-[80%] ${message.role === "user" ? "ml-auto" : ""}`}>
              {message.role === "assistant" ? (
                <div className="border border-rule bg-paper px-4 py-3 text-sm leading-7" dangerouslySetInnerHTML={{ __html: formatChatMarkdown(message.content) }} />
              ) : (
                <div className="whitespace-pre-wrap bg-red px-4 py-3 text-sm leading-7 text-cream">{message.content}</div>
              )}
            </div>
          ))}
          {streaming && streamContent ? (
            <div className="max-w-[80%]">
              <div className="border border-rule bg-paper px-4 py-3 text-sm leading-7" dangerouslySetInnerHTML={{ __html: formatChatMarkdown(streamContent) }} />
            </div>
          ) : null}
          <div ref={messagesEndRef} />
        </div>

        <div className="shrink-0 border-t border-rule bg-paper p-4">
          <div className="mx-auto flex max-w-3xl gap-3">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); handleSend(); } }}
              placeholder={selectedNotebookIds.length ? `向${scopeLabel}提问` : "先选择书目"}
              rows={1}
              disabled={!selectedNotebookIds.length}
              className="min-h-[40px] max-h-[120px] flex-1 resize-none px-3 py-2.5 text-sm disabled:bg-[#f2f1ee]"
            />
            <Button onClick={handleSend} disabled={!canSend}>发送</Button>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
