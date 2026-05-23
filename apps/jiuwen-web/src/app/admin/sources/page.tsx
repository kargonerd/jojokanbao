"use client";

import { useEffect, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE;

type Source = {
  id: string;
  name: string;
  rssUrl: string;
};

export default function SourcesPage() {
  const [sources, setSources] = useState<Source[]>([]);
  const [name, setName] = useState("");
  const [rssUrl, setRssUrl] = useState("");
  const [status, setStatus] = useState("");

  async function loadSources() {
    const res = await fetch(`${API_BASE}/sources`, { cache: "no-store" });
    if (!res.ok) return;
    setSources(await res.json());
  }

  useEffect(() => {
    void loadSources();
  }, []);

  async function createSource() {
    if (!name || !rssUrl) return;
    setStatus("创建中...");
    await fetch(`${API_BASE}/sources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, rssUrl })
    });
    setName("");
    setRssUrl("");
    await loadSources();
    setStatus("");
  }

  async function removeSource(id: string) {
    setStatus("删除中...");
    await fetch(`${API_BASE}/sources/${id}`, { method: "DELETE" });
    await loadSources();
    setStatus("");
  }

  async function triggerRss() {
    setStatus("拉取中...");
    await fetch(`${API_BASE}/jobs/fetch-rss`, { method: "POST" });
    setStatus("");
  }

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <main className="mx-auto w-full max-w-3xl px-6 py-10">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">RSS 源管理</h1>
          <button className="rounded-md bg-zinc-900 px-3 py-2 text-xs text-white" onClick={triggerRss}>
            拉取 RSS
          </button>
        </div>
        <p className="mt-2 text-sm text-zinc-600">当前源（POST /sources, DELETE /sources/:id）</p>

        <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-4">
          <div className="text-sm font-medium">新增源</div>
          <div className="mt-3 grid gap-2">
            <input
              className="rounded-md border border-zinc-200 px-3 py-2 text-sm"
              placeholder="名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className="rounded-md border border-zinc-200 px-3 py-2 text-sm"
              placeholder="RSS URL"
              value={rssUrl}
              onChange={(e) => setRssUrl(e.target.value)}
            />
            <button className="rounded-md bg-zinc-900 px-3 py-2 text-xs text-white" onClick={createSource}>
              创建
            </button>
          </div>
        </div>

        <div className="mt-4 text-xs text-zinc-500">{status}</div>

        <div className="mt-6 grid gap-3">
          {sources.length === 0 && <div className="text-sm text-zinc-500">暂无源</div>}
          {sources.map((s) => (
            <div key={s.id} className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-4">
              <div>
                <div className="text-sm font-medium">{s.name}</div>
                <div className="mt-1 text-xs text-zinc-500">{s.rssUrl}</div>
              </div>
              <button
                className="rounded-md border border-zinc-200 px-3 py-2 text-xs text-zinc-700"
                onClick={() => removeSource(s.id)}
              >
                删除
              </button>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
