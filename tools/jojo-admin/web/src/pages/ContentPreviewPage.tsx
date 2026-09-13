import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Link, useParams } from "react-router-dom";
import type { JojoTocNode } from "@jojo/content";
import { renderedBody, renderedChapter, shouldRenderChapterTitle } from "@jojo/content/book-renderer";
import { contentApi, type ContentJob } from "../content/api";
import { loadPreviewChapter, loadPreviewItem, previewClient, type PreviewChapter, type PreviewItem } from "../content/preview";
import "./ContentPreviewPage.css";

export function ContentPreviewPage() {
  const { jobId = "" } = useParams();
  const [job, setJob] = useState<ContentJob>();
  const [itemIndex, setItemIndex] = useState(0);
  const [item, setItem] = useState<PreviewItem>();
  const [chapterId, setChapterId] = useState("");
  const [chapter, setChapter] = useState<PreviewChapter>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [jump, setJump] = useState({ id: "", token: 0 });
  const article = useRef<HTMLElement>(null);
  const client = useMemo(() => previewClient(jobId), [jobId]);

  useEffect(() => {
    let active = true;
    setJob(undefined); setError("");
    contentApi.job(jobId).then(({ job: value }) => {
      if (!active) return;
      if (!["ready", "publishing", "published", "publish-failed"].includes(value.status)) throw new Error("内容尚未生成，暂时无法预览");
      if (!value.report?.itemsBuilt.length) throw new Error("本次导入没有可预览的书籍");
      setJob(value);
    }).catch((reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [jobId, retry]);

  const manifestObject = job?.report?.itemsBuilt[itemIndex]?.manifestObject;
  useEffect(() => {
    const controller = new AbortController();
    setItem(undefined); setChapterId(""); setChapter(undefined);
    if (manifestObject) {
      setError("");
      loadPreviewItem(client, manifestObject, controller.signal).then((value) => {
        if (controller.signal.aborted) return;
        setItem(value); setChapterId(value.manifest.content.chapters![0]!.id);
        setJump({ id: "", token: Date.now() });
      }).catch((reason: Error) => { if (!controller.signal.aborted) setError(reason.message); });
    }
    return () => controller.abort();
  }, [client, manifestObject, retry]);

  useEffect(() => {
    const controller = new AbortController();
    let loaded: PreviewChapter | undefined;
    setChapter(undefined);
    if (item && chapterId) {
      setError("");
      loadPreviewChapter(item, chapterId, controller.signal).then((value) => {
        loaded = value;
        if (controller.signal.aborted) Object.values(value.assetUrls).forEach(URL.revokeObjectURL);
        else setChapter(value);
      }).catch((reason: Error) => { if (!controller.signal.aborted) setError(reason.message); });
    }
    return () => {
      controller.abort();
      if (loaded) Object.values(loaded.assetUrls).forEach((url) => URL.revokeObjectURL(url));
    };
  }, [item, chapterId, retry]);

  useEffect(() => {
    if (!chapter || !article.current) return;
    const target = jump.id
      ? [...article.current.querySelectorAll<HTMLElement>("[id]")].find((element) => element.id === jump.id)
      : article.current;
    target?.scrollIntoView({ block: "start" });
    if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }); }
  }, [chapter, jump]);

  const chapters = item?.manifest.content.chapters ?? [];
  const position = chapters.findIndex((candidate) => candidate.id === chapterId);
  const chapterMarkup = useMemo(() => chapter ? renderedChapter(chapter.fragment, chapter.assetUrls) : undefined, [chapter]);
  const html = chapterMarkup?.bodyHtml ?? "";

  function navigateChapter(id: string, anchor = "") {
    if (!chapters.some((candidate) => candidate.id === id)) { setError("找不到链接对应的章节"); return; }
    setChapterId(id); setJump((value) => ({ id: anchor, token: value.token + 1 }));
  }

  function followLink(event: MouseEvent<HTMLElement>) {
    const link = (event.target as Element).closest("a");
    if (!link) return;
    const target = link.getAttribute("data-target-id");
    const href = link.getAttribute("href") || "";
    if (target || href.startsWith("#") || link.hasAttribute("data-anchor-id")) {
      event.preventDefault();
      let anchor = link.getAttribute("data-anchor-id") || href.slice(1);
      try { anchor = decodeURIComponent(anchor); } catch { /* Preserve literal source anchors. */ }
      navigateChapter(target || chapterId, anchor);
    } else {
      // Explicit external links open separately and cannot replace the local preview.
      event.preventDefault();
      if (/^https?:\/\//i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
    }
  }

  return <div className="book-preview">
    <header className="preview-topbar">
      <Link to={`/content?job=${encodeURIComponent(jobId)}&step=2`} className="secondary-button">← 返回处理与预览</Link>
      <div><span className="eyebrow">本地阅读预览</span><h1>{item?.manifest.title || "导入结果"}</h1></div>
      <Link to={`/content?job=${encodeURIComponent(jobId)}&step=3`} className="secondary-button">预览完成，设置发布</Link>
    </header>
    <div className="preview-layout">
      <aside className="preview-sidebar">
        {chapter?.coverId && chapter.assetUrls[chapter.coverId] && <img className="preview-cover" src={chapter.assetUrls[chapter.coverId]} alt="书籍封面" />}
        {(job?.report?.itemsBuilt.length ?? 0) > 1 && <label>选择分卷<select value={itemIndex} onChange={(event) => setItemIndex(Number(event.target.value))}>{job!.report!.itemsBuilt.map((built, index) => <option key={built.itemId} value={index}>{built.itemTitle}</option>)}</select></label>}
        <h2>目录 <small>{chapters.length ? `${chapters.length} 章` : ""}</small></h2>
        <nav aria-label="书籍目录"><Toc nodes={item?.manifest.content.toc?.length ? item.manifest.content.toc : chapters.map((value) => ({ ...value, targetId: value.id }))} current={chapterId} onSelect={navigateChapter} /></nav>
      </aside>
      <main className="preview-main">
        {error && <div className="content-error" role="alert"><p>{error}</p><button className="secondary-button" onClick={() => setRetry((value) => value + 1)}>重新加载</button></div>}
        {!chapter && !error && <p role="status">正在读取本地内容…</p>}
        {chapter && <>
          {chapter.warnings.length > 0 && <div className="content-error" role="alert">{chapter.warnings.map((message) => <p key={message}>{message}</p>)}</div>}
          <article ref={article} className="preview-article" aria-label="章节正文" onClick={followLink}>
            <p className="eyebrow">{position + 1} / {chapters.length}</p>
            {shouldRenderChapterTitle(chapter.fragment, html) && <h2 dangerouslySetInnerHTML={{ __html: chapterMarkup?.titleHtml ?? "" }} />}
            <div className="preview-prose" dangerouslySetInnerHTML={{ __html: html }} />
            {chapter.fragment.annotations.length > 0 && <section className="preview-notes" aria-label="本章脚注"><h3>注释</h3>{chapter.fragment.annotations.map((note) => <div key={note.id} id={note.id} className="preview-note">
              <b>{note.label || "注"}</b><div className="preview-prose" dangerouslySetInnerHTML={{ __html: renderedBody({ ...chapter.fragment, title: "", body: note.body, annotations: [] }, chapter.assetUrls) }} /><a href={`#annotation-ref-${note.id}`} aria-label="返回正文脚注标记">↩ 返回正文</a>
            </div>)}</section>}
          </article>
          <nav className="preview-pagination" aria-label="章节翻页">
            <button className="secondary-button" disabled={position <= 0} onClick={() => navigateChapter(chapters[position - 1]!.id)}>上一章</button>
            <span>{position + 1} / {chapters.length}</span>
            <button className="secondary-button" disabled={position >= chapters.length - 1} onClick={() => navigateChapter(chapters[position + 1]!.id)}>下一章</button>
          </nav>
        </>}
      </main>
    </div>
  </div>;
}

function Toc({ nodes, current, onSelect }: { nodes: JojoTocNode[]; current: string; onSelect: (id: string, anchor?: string) => void }) {
  return <ol className="preview-toc">{nodes.map((node) => <li key={node.id}>
    {node.targetId ? <button aria-current={node.targetId === current ? "location" : undefined} onClick={() => onSelect(node.targetId!, node.anchorId)}>{node.title}</button> : <span>{node.title}</span>}
    {node.children?.length ? <Toc nodes={node.children} current={current} onSelect={onSelect} /> : null}
  </li>)}</ol>;
}
