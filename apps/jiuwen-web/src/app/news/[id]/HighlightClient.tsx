"use client";

import { useEffect, useMemo, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE;

type Highlight = {
  id: string;
  text: string;
  startOffset: number;
  endOffset: number;
  createdAt: string;
  displayName?: string | null;
};

type Comment = {
  id: string;
  content: string;
  highlight: { id: string };
  createdAt: string;
  displayName?: string | null;
};

type HighlightClientProps = {
  newsId: string;
  content: string;
  highlights: Highlight[];
  comments: Comment[];
};

function getUserIdentity() {
  if (typeof window === "undefined") return { userId: "", displayName: "" };
  const existing = localStorage.getItem("jojo_user");
  if (existing) return JSON.parse(existing) as { userId: string; displayName: string };
  const userId = crypto.randomUUID();
  const displayName = `路人${Math.floor(Math.random() * 9000 + 1000)}`;
  const data = { userId, displayName };
  localStorage.setItem("jojo_user", JSON.stringify(data));
  return data;
}

export default function HighlightClient(props: HighlightClientProps) {
  const { newsId, content } = props;
  const [highlights, setHighlights] = useState<Highlight[]>(props.highlights);
  const [comments, setComments] = useState<Comment[]>(props.comments);
  const [selectedText, setSelectedText] = useState<string>("");
  const [selectionRange, setSelectionRange] = useState<{ start: number; end: number } | null>(null);
  const [commentText, setCommentText] = useState("");
  const [status, setStatus] = useState<string>("");

  const user = useMemo(() => getUserIdentity(), []);

  useEffect(() => {
    function handleSelection() {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const text = selection.toString();
      if (!text || text.trim().length < 2) return;

      const start = content.indexOf(text);
      if (start === -1) return;
      const end = start + text.length;
      setSelectedText(text);
      setSelectionRange({ start, end });
    }

    document.addEventListener("mouseup", handleSelection);
    return () => document.removeEventListener("mouseup", handleSelection);
  }, [content]);

  async function submitHighlight() {
    if (!selectionRange || !selectedText) return;
    setStatus("创建中...");
    const res = await fetch(`${API_BASE}/highlights`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        newsId,
        userId: user.userId,
        displayName: user.displayName,
        startOffset: selectionRange.start,
        endOffset: selectionRange.end,
        text: selectedText
      })
    });
    const created = await res.json();
    if (created?.id) {
      setHighlights([created, ...highlights]);
      setSelectedText("");
      setSelectionRange(null);
    }
    setStatus("");
  }

  async function submitComment(highlightId: string) {
    if (!commentText.trim()) return;
    setStatus("评论中...");
    const res = await fetch(`${API_BASE}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        highlightId,
        userId: user.userId,
        displayName: user.displayName,
        content: commentText
      })
    });
    const created = await res.json();
    if (created?.id) {
      setComments([created, ...comments]);
      setCommentText("");
    }
    setStatus("");
  }

  return (
    <section className="mt-10">
      <h2 className="text-xl font-semibold">划线评论</h2>
      <div className="mt-2 text-xs text-zinc-500">当前昵称：{user.displayName}</div>

      {selectedText && (
        <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-4">
          <div className="text-sm text-zinc-700">选中：{selectedText}</div>
          <div className="mt-3 flex items-center gap-2">
            <button
              className="rounded-md bg-zinc-900 px-3 py-2 text-xs text-white"
              onClick={submitHighlight}
            >
              生成划线
            </button>
            <div className="text-xs text-zinc-500">{status}</div>
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-4">
        {highlights.length === 0 && <div className="text-sm text-zinc-500">暂无划线评论</div>}
        {highlights.map((hl) => (
          <div key={hl.id} className="rounded-lg border border-zinc-200 bg-white p-4">
            <div className="text-xs text-zinc-500">
              {hl.displayName || "匿名"} · {hl.text}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <input
                className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                placeholder="写下你的评论..."
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
              />
              <button
                className="rounded-md bg-zinc-900 px-3 py-2 text-xs text-white"
                onClick={() => submitComment(hl.id)}
              >
                评论
              </button>
            </div>
            <div className="mt-3 space-y-2">
              {comments
                .filter((c) => c.highlight.id === hl.id)
                .map((c) => (
                  <div key={c.id} className="text-sm text-zinc-700">
                    <span className="text-xs text-zinc-500">{c.displayName || "匿名"}：</span> {c.content}
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
