"use client";

import { useState } from "react";
import { API_BASE } from "../../api";

type AskResponse = {
  answer: string;
  citations: { articleId: string; title: string; url?: string | null; source?: { name: string } | null }[];
  followUps: string[];
};

export default function AskAgentClient({ newsId }: { newsId: string }) {
  const [question, setQuestion] = useState("请总结这条新闻，并指出还需要追问什么。");
  const [response, setResponse] = useState<AskResponse | null>(null);
  const [status, setStatus] = useState("");

  async function askAgent() {
    if (!question.trim()) return;
    setStatus("Pi agent 正在阅读…");
    setResponse(null);
    try {
      const res = await fetch(`${API_BASE}/ai/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newsId, question }),
      });
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      setResponse((await res.json()) as AskResponse);
      setStatus("");
    } catch {
      setStatus("问答失败，请确认后端服务已启动。");
    }
  }

  return (
    <section className="mt-10 border-2 border-red p-5">
      <p className="m-0 text-xs font-bold tracking-[0.2em] text-red">ASK PI AGENT</p>
      <h2 className="m-0 mt-2 text-2xl font-black">追问这篇新闻</h2>
      <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto]">
        <input
          className="w-full border-rule-dark"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="输入你想追问的事实、背景或旧闻对照"
        />
        <button className="btn" onClick={askAgent}>
          追问
        </button>
      </div>
      {status ? <div className="mt-3 text-xs font-bold text-muted">{status}</div> : null}
      {response ? (
        <div className="mt-5 border-t border-rule pt-4">
          <p className="m-0 text-sm leading-7 text-ink">{response.answer}</p>
          <div className="mt-4">
            <div className="text-xs font-bold tracking-[0.16em] text-muted">引用</div>
            <div className="mt-2 space-y-2">
              {response.citations.map((citation) => (
                <a
                  key={citation.articleId}
                  href={citation.url || "#"}
                  target="_blank"
                  rel="noreferrer"
                  className="block border border-rule px-3 py-2 text-sm text-ink hover:border-red hover:text-red"
                >
                  {citation.source?.name ? `${citation.source.name} · ` : ""}
                  {citation.title}
                </a>
              ))}
            </div>
          </div>
          <div className="mt-4">
            <div className="text-xs font-bold tracking-[0.16em] text-muted">继续追问</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {response.followUps.map((item) => (
                <button key={item} className="tag text-left" onClick={() => setQuestion(item)}>
                  {item}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
