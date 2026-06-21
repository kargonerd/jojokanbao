"use client";

import { useEffect, useMemo, useState } from "react";
import { API_BASE } from "../../api";

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
  highlightId?: string;
  highlight?: { id: string };
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
  if (existing) {
    try {
      return JSON.parse(existing) as { userId: string; displayName: string };
    } catch {
      localStorage.removeItem("jojo_user");
    }
  }
  const userId = crypto.randomUUID();
  const displayName = `路人${Math.floor(Math.random() * 9000 + 1000)}`;
  const data = { userId, displayName };
  localStorage.setItem("jojo_user", JSON.stringify(data));
  return data;
}

function getCommentHighlightId(comment: Comment) {
  return comment.highlightId || comment.highlight?.id;
}

export default function HighlightClient(props: HighlightClientProps) {
  const { newsId, content } = props;
  const [highlights, setHighlights] = useState<Highlight[]>(props.highlights);
  const [comments, setComments] = useState<Comment[]>(props.comments);
  const [selectedText, setSelectedText] = useState("");
  const [selectionRange, setSelectionRange] = useState<{ start: number; end: number } | null>(null);
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("");

  const user = useMemo(() => getUserIdentity(), []);

  useEffect(() => {
    function handleSelection() {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const text = selection.toString().trim();
      if (text.length < 2) return;

      const start = content.indexOf(text);
      if (start === -1) return;
      setSelectedText(text);
      setSelectionRange({ start, end: start + text.length });
    }

    document.addEventListener("mouseup", handleSelection);
    return () => document.removeEventListener("mouseup", handleSelection);
  }, [content]);

  async function submitHighlight() {
    if (!selectionRange || !selectedText) return;
    setStatus("创建划线中…");
    try {
      const res = await fetch(`${API_BASE}/highlights`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newsId,
          userId: user.userId,
          displayName: user.displayName,
          startOffset: selectionRange.start,
          endOffset: selectionRange.end,
          text: selectedText,
        }),
      });
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      const created = (await res.json()) as Highlight;
      if (created?.id) {
        setHighlights((current) => [created, ...current]);
        setSelectedText("");
        setSelectionRange(null);
      }
      setStatus("");
    } catch {
      setStatus("创建失败，请确认后端服务已启动。");
    }
  }

  async function submitComment(highlightId: string) {
    const content = commentDrafts[highlightId]?.trim();
    if (!content) return;
    setStatus("评论中…");
    try {
      const res = await fetch(`${API_BASE}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          highlightId,
          userId: user.userId,
          displayName: user.displayName,
          content,
        }),
      });
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      const created = (await res.json()) as Comment;
      if (created?.id) {
        setComments((current) => [created, ...current]);
        setCommentDrafts((current) => ({ ...current, [highlightId]: "" }));
      }
      setStatus("");
    } catch {
      setStatus("评论失败，请确认后端服务已启动。");
    }
  }

  return (
    <section className="mt-10 border-t-2 border-rule-dark pt-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="m-0 text-xs font-bold tracking-[0.2em] text-muted">READER NOTES</p>
          <h2 className="m-0 mt-2 text-2xl font-black">划线评论</h2>
        </div>
        <div className="text-xs font-bold tracking-[0.12em] text-muted">当前昵称：{user.displayName}</div>
      </div>

      {selectedText ? (
        <div className="mt-5 border-2 border-red bg-paper p-4">
          <div className="text-sm leading-6 text-ink">选中：{selectedText}</div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button className="btn" onClick={submitHighlight}>
              生成划线
            </button>
            <div className="text-xs font-bold text-muted">{status}</div>
          </div>
        </div>
      ) : null}

      <div className="mt-5 grid gap-4">
        {highlights.length === 0 ? <div className="border border-rule p-4 text-sm text-muted">暂无划线评论</div> : null}
        {highlights.map((highlight) => (
          <div key={highlight.id} className="border border-rule bg-paper p-4">
            <div className="text-xs font-bold tracking-[0.12em] text-muted">
              {highlight.displayName || "匿名"} · {highlight.text}
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-[1fr_auto]">
              <input
                className="w-full"
                placeholder="写下你的评论…"
                value={commentDrafts[highlight.id] || ""}
                onChange={(event) => setCommentDrafts((current) => ({ ...current, [highlight.id]: event.target.value }))}
              />
              <button className="btn btn-outline" onClick={() => submitComment(highlight.id)}>
                评论
              </button>
            </div>
            <div className="mt-3 space-y-2">
              {comments
                .filter((comment) => getCommentHighlightId(comment) === highlight.id)
                .map((comment) => (
                  <div key={comment.id} className="border-l-4 border-red pl-3 text-sm leading-6 text-ink">
                    <span className="text-xs font-bold text-muted">{comment.displayName || "匿名"}：</span> {comment.content}
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
