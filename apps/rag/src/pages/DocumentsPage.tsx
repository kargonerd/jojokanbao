import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AppShell, Button, EmptyState, PageHeader } from "@jojo/ui";
import { documentApi, healthApi, type AgentHealth, type DocumentSummary } from "../api";
import { RagHeader } from "../components/RagHeader";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function DocumentsPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [health, setHealth] = useState<AgentHealth | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function reload() {
    const [nextDocuments, nextHealth] = await Promise.all([documentApi.list(), healthApi.get()]);
    setDocuments(nextDocuments);
    setHealth(nextHealth);
  }

  useEffect(() => {
    void reload().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, []);

  async function handleAdd() {
    if (!file) {
      setError("请先选择一份 Markdown 文件");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const document = await documentApi.add(file, title);
      setNotice(`已添加《${document.title}》`);
      setFile(null);
      setTitle("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(document: DocumentSummary) {
    if (!window.confirm(`删除《${document.title}》？本地副本会一并删除。`)) return;
    await documentApi.remove(document.id);
    setNotice(`已删除《${document.title}》`);
    await reload();
  }

  return (
    <AppShell header={<RagHeader />} headerClassName="h-14" contentClassName="bg-paper-soft">
      <div className="max-w-5xl mx-auto px-4 py-8 md:px-8 md:py-12">
        <PageHeader
          eyebrow="Source desk"
          title="登记一份原始文档"
          description="当前验证阶段只接收 Markdown。文件保存在本机，不做切片、不生成向量。"
          actions={<Link to="/chat" className="btn">去提问</Link>}
        />

        <section className="grid lg:grid-cols-[1.25fr_.75fr] border border-rule-dark bg-paper">
          <div className="p-5 md:p-8 border-b lg:border-b-0 lg:border-r border-rule-dark">
            <label className="block text-xs font-bold tracking-[0.18em] text-red mb-3">MARKDOWN 文件</label>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full min-h-40 border border-dashed border-red bg-paper-soft px-6 py-8 text-left hover:-translate-y-0.5 hover:shadow-[4px_4px_0_rgba(139,26,26,.14)] transition-all"
            >
              <span className="block text-2xl font-black text-ink mb-3">{file ? file.name : "选择 .md 文件"}</span>
              <span className="block text-xs leading-6 text-muted">
                {file ? `${formatBytes(file.size)} · 点击可重新选择` : "最大 12 MB；标题默认取 Markdown 的第一个一级标题。"}
              </span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,text/markdown,text/plain"
              className="sr-only"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setError("");
              }}
            />

            <label className="block mt-5">
              <span className="block text-xs font-bold text-muted mb-2">显示标题（可选）</span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="留空则读取 Markdown 标题"
                className="w-full h-11"
              />
            </label>

            <div className="mt-5 flex items-center gap-4">
              <Button onClick={handleAdd} disabled={busy}>{busy ? "正在添加…" : "添加文档"}</Button>
              {notice && <span className="text-xs font-bold text-red">{notice}</span>}
            </div>
            {error && <p role="alert" className="mt-4 text-sm text-red">{error}</p>}
          </div>

          <aside className="p-5 md:p-8 bg-ink text-cream">
            <p className="text-[10px] tracking-[0.2em] text-cream/60 mt-0">AGENT STATUS</p>
            <p className="text-xl font-black mt-3 mb-2">{health?.agent.model ?? "正在检查…"}</p>
            <p className="text-xs leading-6 text-cream/70 m-0">
              {health?.agent.configured
                ? `运行模式：${health.agent.mode}`
                : health?.agent.mode === "codex"
                  ? "尚未完成 Pi Codex OAuth；文档管理可用，真实问答暂不可用。"
                  : "尚未配置 OPENAI_API_KEY；文档管理可用，真实问答暂不可用。"}
            </p>
            <div className="mt-8 pt-4 border-t border-cream/20 text-xs leading-6 text-cream/70">
              文档内容被当作不可信证据。Agent 只能搜索和按行读取当前选中的文档。
            </div>
          </aside>
        </section>

        <section className="mt-10">
          <div className="flex items-end justify-between border-b border-rule-dark pb-3 mb-4">
            <div>
              <p className="kicker mb-2">Local archive</p>
              <h2 className="text-lg font-black m-0">已登记文档</h2>
            </div>
            <span className="font-sans text-xs text-muted">{documents.length} 份</span>
          </div>

          {documents.length === 0 ? (
            <EmptyState title="还没有文档" description="先添加上面的 Markdown，再进入问答页。" />
          ) : (
            <div className="divide-y divide-rule border-y border-rule">
              {documents.map((document, index) => (
                <article key={document.id} className="grid grid-cols-[3rem_1fr_auto] gap-4 items-center py-5">
                  <span className="font-sans text-xs text-muted">{String(index + 1).padStart(2, "0")}</span>
                  <div className="min-w-0">
                    <h3 className="text-base font-black text-ink m-0 truncate">{document.title}</h3>
                    <p className="font-sans text-[11px] text-muted mt-2 mb-0">
                      {document.lineCount.toLocaleString()} 行 · {formatBytes(document.sizeBytes)} · {document.originalName}
                    </p>
                  </div>
                  <Button variant="text" onClick={() => void handleRemove(document)}>删除</Button>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
