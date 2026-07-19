import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AppShell, Button, EmptyState } from "@jojo/ui";
import { RagHeader } from "../components/RagHeader";
import { useChatStore, type ChatMessage } from "../stores/chatStore";
import { formatChatMarkdown } from "../utils/markdown";

function UsageLedger({ message }: { message: ChatMessage }) {
  if (!message.usage) return null;
  const usage = message.usage;
  const modelCostLabel = usage.model.startsWith("openai-codex/") ? "API 等价估算" : "模型估算";
  return (
    <div className="mt-3 border-t border-rule pt-3 grid grid-cols-2 sm:grid-cols-5 gap-x-4 gap-y-2 font-sans text-[10px] text-muted">
      <span><b className="block text-ink">{usage.inputTokens.toLocaleString()}</b>输入</span>
      <span><b className="block text-ink">{usage.cachedInputTokens.toLocaleString()}</b>缓存输入</span>
      <span><b className="block text-ink">{usage.outputTokens.toLocaleString()}</b>输出</span>
      <span><b className="block text-ink">${usage.modelCostUsd.toFixed(5)}</b>{modelCostLabel}</span>
      <span><b className="block text-ink">¥{usage.functionCostCnyEstimate.toFixed(4)}</b>SCF 基础估算</span>
    </div>
  );
}

export function ChatPage() {
  const {
    documents,
    selectedDocumentIds,
    messages,
    streaming,
    streamContent,
    streamStatus,
    streamTraces,
    loadDocuments,
    toggleDocument,
    sendMessage,
    clearConversation,
  } = useChatStore();
  const [input, setInput] = useState("");
  const [loadError, setLoadError] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadDocuments().catch((caught: unknown) => setLoadError(caught instanceof Error ? caught.message : String(caught)));
  }, [loadDocuments]);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamContent, streamTraces]);

  function handleSend() {
    if (!input.trim() || streaming || selectedDocumentIds.length === 0) return;
    sendMessage(input);
    setInput("");
  }

  return (
    <AppShell
      header={<RagHeader />}
      headerClassName="h-14"
      sidebar={
        <div className="h-full flex flex-col">
          <div>
            <p className="kicker mb-3">Evidence set</p>
            <h2 className="text-base font-black text-ink mt-0 mb-1">本次查阅</h2>
            <p className="text-[11px] leading-5 text-muted mt-0 mb-5">只允许 Agent 阅读勾选的文档。</p>
          </div>
          <div className="space-y-2">
            {documents.map((document) => (
              <label key={document.id} className="flex items-start gap-3 py-2 text-xs text-ink cursor-pointer border-b border-rule">
                <input
                  type="checkbox"
                  checked={selectedDocumentIds.includes(document.id)}
                  onChange={() => toggleDocument(document.id)}
                  className="mt-0.5 accent-[var(--color-red)]"
                />
                <span className="min-w-0">
                  <b className="block leading-5">{document.title}</b>
                  <span className="font-sans text-[10px] text-muted">{document.lineCount.toLocaleString()} 行</span>
                </span>
              </label>
            ))}
          </div>
          {documents.length === 0 && <p className="text-xs leading-6 text-muted">尚无文档。</p>}
          <Link to="/documents" className="mt-5 text-xs font-bold">+ 添加 Markdown</Link>
          <div className="mt-auto pt-5 border-t border-rule font-sans text-[10px] leading-5 text-muted">
            无向量检索<br />Pi Agent · 只读工具
          </div>
        </div>
      }
      sidebarClassName="hidden md:block w-64"
      contentClassName="flex flex-col bg-paper-soft"
    >
      <div className="min-h-0 flex-1 flex flex-col">
        <div className="h-14 flex items-center justify-between px-4 md:px-6 border-b border-rule bg-paper shrink-0">
          <div>
            <h1 className="text-sm font-black text-ink m-0">向原文提问</h1>
            <p className="font-sans text-[10px] text-muted mt-1 mb-0">搜索 → 阅读 → 带行号作答</p>
          </div>
          <button onClick={clearConversation} className="text-xs font-bold text-muted border-0 bg-transparent hover:text-red">清空对话</button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8 md:py-8">
          <div className="max-w-3xl mx-auto space-y-6">
            {loadError && <p role="alert" className="border border-red px-4 py-3 text-sm text-red bg-paper">{loadError}</p>}
            {messages.length === 0 && !streaming && (
              documents.length === 0 ? (
                <EmptyState
                  title="先放一份原文进来"
                  description={<span>到 <Link to="/documents">文档管理</Link> 添加 Markdown，然后回来提问。</span>}
                />
              ) : (
                <div className="border-y border-rule-dark py-10 md:py-14">
                  <p className="kicker mb-5">Ask the archive</p>
                  <h2 className="text-3xl md:text-5xl font-black leading-tight tracking-tight text-ink mt-0 mb-5">
                    不先切碎，<br />让 Agent 自己翻书。
                  </h2>
                  <p className="max-w-xl text-sm leading-7 text-muted mb-0">
                    用简体中文直接提问。回答会保留原文行号，并在末尾显示本次 Token 与估算成本。
                  </p>
                </div>
              )
            )}

            {messages.map((message, index) => (
              <article key={`${message.role}-${index}`} className={message.role === "user" ? "ml-auto max-w-[86%] md:max-w-[72%]" : "max-w-full"}>
                {message.role === "user" ? (
                  <div className="bg-red text-cream px-4 py-3 text-sm leading-7 whitespace-pre-wrap">{message.content}</div>
                ) : (
                  <div className="border border-rule-dark bg-paper px-5 py-5 md:px-6">
                    {message.traces && message.traces.length > 0 && (
                      <div className="mb-4 flex flex-wrap gap-2">
                        {message.traces.map((trace, traceIndex) => (
                          <span key={`${trace}-${traceIndex}`} className="border border-rule px-2 py-1 font-sans text-[10px] text-muted">{trace}</span>
                        ))}
                      </div>
                    )}
                    <div className="chat-markdown text-sm leading-7" dangerouslySetInnerHTML={{ __html: formatChatMarkdown(message.content) }} />
                    <UsageLedger message={message} />
                  </div>
                )}
              </article>
            ))}

            {streaming && (
              <article className="border border-rule-dark bg-paper px-5 py-5 md:px-6">
                <div className="flex items-center gap-3 mb-4 font-sans text-[10px] font-bold tracking-wider text-red">
                  <span className="inline-block w-2 h-2 bg-red animate-pulse" aria-hidden="true" />
                  {streamStatus || "Agent 正在工作"}
                </div>
                {streamTraces.length > 0 && (
                  <div className="mb-4 flex flex-wrap gap-2">
                    {streamTraces.map((trace, index) => <span key={`${trace}-${index}`} className="border border-rule px-2 py-1 font-sans text-[10px] text-muted">{trace}</span>)}
                  </div>
                )}
                {streamContent && <div className="chat-markdown text-sm leading-7" dangerouslySetInnerHTML={{ __html: formatChatMarkdown(streamContent) }} />}
              </article>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <div className="shrink-0 border-t border-rule-dark bg-paper p-4 md:px-8">
          <div className="max-w-3xl mx-auto">
            <div className="flex gap-3">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    handleSend();
                  }
                }}
                placeholder={selectedDocumentIds.length ? "输入问题，Enter 发送…" : "请先选择一份文档"}
                rows={2}
                disabled={selectedDocumentIds.length === 0}
                className="flex-1 resize-none text-sm py-3 px-3 min-h-[52px] max-h-36"
              />
              <Button onClick={handleSend} disabled={streaming || !input.trim() || selectedDocumentIds.length === 0} className="h-auto px-6">
                {streaming ? "翻检中" : "提问"}
              </Button>
            </div>
            <p className="font-sans text-[10px] text-muted mt-2 mb-0">Shift + Enter 换行 · 当前选择 {selectedDocumentIds.length} 份文档</p>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
