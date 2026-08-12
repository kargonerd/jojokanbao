import { useEffect, useRef, useState } from "react";
import { useChatStore } from "../stores/chatStore";
import { formatChatMarkdown } from "../utils/markdown";
import { AppShell, Button, EmptyState } from "@jojo/ui";
import { RagHeader } from "../RagHeader";
import { Link } from "react-router-dom";

export function ChatPage() {
  const { notebooks, selectedNotebook, sources, selectedSourceIds, messages, loading, error, streaming, streamContent, loadNotebooks, selectNotebook, toggleSource, sendMessage, clearConversation } = useChatStore();
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => { void loadNotebooks(); }, [loadNotebooks]);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, streamContent]);

  const handleSend = () => { if (input.trim() && !streaming) { sendMessage(input); setInput(""); } };

  return (
    <AppShell
      header={<RagHeader />}
      sidebar={
        <>
        <h2 className="text-sm font-bold text-red tracking-wider mb-4">馆藏 Dataset</h2>
        {loading ? <p className="text-xs text-muted">正在加载…</p> : null}
        {notebooks.map((nb) => (
          <button key={nb.id} onClick={() => selectNotebook(nb.id)} className={`block w-full text-left px-3 py-2 text-sm font-bold border-0 bg-transparent mb-1 transition-colors ${selectedNotebook === nb.id ? "text-red bg-red/5" : "text-ink hover:text-red"}`}>
            {nb.title || nb.name}
          </button>
        ))}
        {selectedNotebook && sources.length > 0 && (
          <div className="mt-4 pt-4 border-t border-rule">
            <h3 className="text-xs font-bold text-muted tracking-wider mb-2">书籍 / 分卷范围</h3>
            {sources.map((s) => (
              <label key={s.id} className="flex items-center gap-2 py-1 text-xs text-ink cursor-pointer">
                <input type="checkbox" checked={selectedSourceIds.includes(s.id)} onChange={() => toggleSource(s.id)} className="accent-[var(--color-red)]" />
                <span className="truncate">{s.title || s.name}</span>
                <Link className="ml-auto shrink-0 font-bold text-red no-underline" to={`/rag/source/${encodeURIComponent(selectedNotebook)}/${encodeURIComponent(s.itemKey || s.id)}`}>阅读</Link>
              </label>
            ))}
          </div>
        )}
        </>
      }
      sidebarClassName="hidden md:block w-64"
      contentClassName="flex flex-col"
    >

      {/* Main chat area */}
      <div className="min-h-0 flex-1 flex flex-col">
        {/* Header */}
        <div className="h-12 flex items-center justify-between px-4 border-b border-rule shrink-0">
          <h1 className="text-sm font-bold text-ink m-0">JOJO RAG</h1>
          <button onClick={clearConversation} className="text-xs font-bold text-muted border-0 bg-transparent hover:text-red cursor-pointer">清空对话</button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
          {error ? <div role="alert" className="border-l-4 border-red bg-red/5 px-4 py-3 text-sm text-red">{error}</div> : null}
          {messages.length === 0 && !streaming && (
            <EmptyState title="有什么想问的？" description="Agent 会先搜索，再决定读取命中章节还是扫描整本" />
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`max-w-[80%] ${msg.role === "user" ? "ml-auto" : ""}`}>
              {msg.role === "assistant" ? (
                <div className="border border-rule bg-paper px-4 py-3 text-sm leading-7" dangerouslySetInnerHTML={{ __html: formatChatMarkdown(msg.content) }} />
              ) : (
                <div className="whitespace-pre-wrap bg-red px-4 py-3 text-sm leading-7 text-cream">{msg.content}</div>
              )}
            </div>
          ))}
          {streaming && streamContent && (
            <div className="max-w-[80%]">
              <div className="px-4 py-3 text-sm leading-7 border border-rule bg-paper" dangerouslySetInnerHTML={{ __html: formatChatMarkdown(streamContent) }} />
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Composer */}
        <div className="shrink-0 border-t border-rule p-4">
          <div className="flex gap-3 max-w-3xl mx-auto">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder="输入问题..."
              rows={1}
              className="flex-1 resize-none text-sm py-2.5 px-3 min-h-[40px] max-h-[120px]"
            />
            <Button onClick={handleSend} className={streaming ? "opacity-50 pointer-events-none" : ""}>发送</Button>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
