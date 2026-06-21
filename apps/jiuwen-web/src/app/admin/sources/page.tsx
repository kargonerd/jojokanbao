"use client";

import { useEffect, useState } from "react";
import { Button, EmptyState, Field, ListItem, PageFrame, PageHeader, Panel, TextInput } from "@jojo/ui";
import { API_BASE } from "../../api";

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
    <div className="min-h-screen bg-paper text-ink">
      <PageFrame maxWidth="md">
        <PageHeader
          title="RSS 源管理"
          description="当前源（POST /sources, DELETE /sources/:id）"
          actions={<Button onClick={triggerRss}>拉取 RSS</Button>}
        />

        <Panel className="p-4">
          <div className="text-sm font-bold text-ink">新增源</div>
          <div className="mt-3 grid gap-2">
            <Field>
              <TextInput className="w-full" placeholder="名称" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field>
              <TextInput className="w-full" placeholder="RSS URL" value={rssUrl} onChange={(e) => setRssUrl(e.target.value)} />
            </Field>
            <Button onClick={createSource}>创建</Button>
          </div>
        </Panel>

        <div className="mt-4 text-xs text-muted">{status}</div>

        <div className="mt-6 grid gap-3">
          {sources.length === 0 && <EmptyState title="暂无源" />}
          {sources.map((s) => (
            <ListItem
              key={s.id}
              title={s.name}
              meta={s.rssUrl}
              actions={<Button variant="outline" onClick={() => removeSource(s.id)}>删除</Button>}
            />
          ))}
        </div>
      </PageFrame>
    </div>
  );
}
