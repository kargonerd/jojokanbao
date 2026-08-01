import { useEffect, useState, type FormEvent } from "react";
import { OldsHeader } from "../OldsHeader";
import { oldsApi, type OldsSource } from "../api";

export function OldsSourcesPage() {
  const [sources, setSources] = useState<OldsSource[]>([]);
  const [name, setName] = useState("");
  const [rssUrl, setRssUrl] = useState("");
  const [status, setStatus] = useState("");

  const load = async () => setSources(await oldsApi.listSources());

  useEffect(() => { void load(); }, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !rssUrl.trim()) return;
    setStatus("创建中…");
    await oldsApi.createSource(name.trim(), rssUrl.trim());
    setName("");
    setRssUrl("");
    await load();
    setStatus("");
  };

  return (
    <div className="min-h-screen bg-paper text-ink">
      <OldsHeader />
      <main className="mx-auto max-w-3xl px-5 py-8 md:px-8">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b-4 border-red pb-5">
          <div><p className="kicker">Olds sources</p><h1 className="mt-2 text-3xl font-black">RSS 来源管理</h1></div>
          <button className="btn btn-outline" type="button" onClick={() => void oldsApi.fetchRss()}>立即拉取</button>
        </div>
        <form className="mt-6 grid gap-3 border border-rule p-5" onSubmit={create}>
          <input className="input" placeholder="来源名称" value={name} onChange={(event) => setName(event.target.value)} />
          <input className="input" type="url" placeholder="RSS URL" value={rssUrl} onChange={(event) => setRssUrl(event.target.value)} />
          <button className="btn" type="submit">新增来源</button>
        </form>
        <p className="mt-3 text-xs text-muted">{status}</p>
        <div className="mt-6 grid gap-3">
          {sources.map((source) => (
            <div key={source.id} className="flex items-center justify-between gap-4 border border-rule p-4">
              <div className="min-w-0"><strong>{source.name}</strong><p className="mt-1 truncate text-xs text-muted">{source.rssUrl}</p></div>
              <button className="btn btn-outline" type="button" onClick={() => void oldsApi.deleteSource(source.id).then(load)}>删除</button>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
