import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAccountSessionStore } from "../../account/session";
import { SelectableAnnotationArticle } from "../../annotations/SelectableAnnotationArticle";
import type { TextAnchor } from "../../annotations/types";
import { explainTimesSelection, type TimesExplanationMetadata } from "../ai";
import { timesApi, type TimesNewsItem } from "../api";
import { TimesExplanationPanel } from "../components/TimesExplanationPanel";
import {
  markTimesArticleRead,
  markTimesArticleUnread,
  useTimesReadStore,
} from "../readStore";

function safeNewsUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function materializeAssets(news: TimesNewsItem): string | null {
  if (!news.content || news.contentFormat !== "html") return null;
  // Sanitize publisher HTML before adding object URLs that were created from
  // our own decoded Delivery objects. DOMPurify intentionally removes blob:
  // URLs, so adding the trusted image nodes before sanitizing would make every
  // archived image disappear.
  const safeContent = DOMPurify.sanitize(news.content, { ADD_ATTR: ["data-asset-id"] });
  const document = new DOMParser().parseFromString(safeContent, "text/html");
  const assets = new Map(news.assets.map((asset) => [asset.id, asset]));
  for (const figure of document.querySelectorAll<HTMLElement>("figure[data-asset-id]")) {
    const id = figure.dataset.assetId;
    const asset = id ? assets.get(id) : undefined;
    const url = id ? news.assetUrls?.[id] : undefined;
    if (!asset || !url) {
      figure.remove();
      continue;
    }
    const image = document.createElement("img");
    image.src = url;
    image.alt = asset.alt || asset.caption || "";
    image.loading = "lazy";
    image.decoding = "async";
    figure.prepend(image);
    if (asset.caption && !figure.querySelector("figcaption")) {
      const caption = document.createElement("figcaption");
      caption.textContent = asset.caption;
      figure.append(caption);
    }
  }
  return document.body.innerHTML;
}

export function TimesDetailPage({
  issueDate: providedIssueDate,
  newsId: providedNewsId,
  embedded = false,
  markReadOnOpen = true,
}: {
  issueDate?: string;
  newsId?: string;
  embedded?: boolean;
  markReadOnOpen?: boolean;
} = {}) {
  const params = useParams();
  const issueDate = providedIssueDate || params.issueDate || "";
  const newsId = providedNewsId || params.newsId || "";
  const [news, setNews] = useState<TimesNewsItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readNotice, setReadNotice] = useState("");
  const [explanation, setExplanation] = useState<{
    anchor: TextAnchor;
    answer: string;
    status: string;
    error: string;
    metadata?: TimesExplanationMetadata;
  }>();
  const cancelExplanation = useRef<() => void>(() => {});
  const userId = useAccountSessionStore((state) => state.userId);
  const read = useTimesReadStore((state) => Boolean(state.readById[newsId]));
  const originalUrl = safeNewsUrl(news?.url);
  const articleHtml = useMemo(() => news ? materializeAssets(news) : null, [news]);

  useEffect(() => {
    let active = true;
    let urls: string[] = [];
    setNews(null);
    setError(null);
    setReadNotice("");
    cancelExplanation.current();
    setExplanation(undefined);
    void timesApi.getNews(issueDate, newsId).then((value) => {
      urls = Object.values(value.assetUrls ?? {});
      if (active) {
        setNews(value);
        if (markReadOnOpen) {
          void markTimesArticleRead(value.id, value.issueDate, userId).catch((reason: unknown) => {
            if (active) setReadNotice(reason instanceof Error ? reason.message : String(reason));
          });
        }
      }
      else for (const url of urls) URL.revokeObjectURL(url);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "新闻读取失败");
    });
    return () => {
      active = false;
      cancelExplanation.current();
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [issueDate, markReadOnOpen, newsId, userId]);

  function startExplanation(anchor: TextAnchor): void {
    if (!news) return;
    cancelExplanation.current();
    setExplanation({ anchor, answer: "", status: "正在准备…", error: "" });
    cancelExplanation.current = explainTimesSelection(news, anchor, {
      onStatus(status) {
        setExplanation((current) => current ? { ...current, status } : current);
      },
      onChunk(text) {
        setExplanation((current) => current ? { ...current, answer: current.answer + text } : current);
      },
      onDone(metadata) {
        setExplanation((current) => current ? { ...current, status: "解释完成", metadata } : current);
      },
      onError(message) {
        setExplanation((current) => current ? { ...current, status: "", error: message } : current);
      },
    });
  }

  function closeExplanation(): void {
    cancelExplanation.current();
    cancelExplanation.current = () => {};
    setExplanation(undefined);
  }

  async function toggleRead(): Promise<void> {
    if (!news) return;
    setReadNotice("");
    try {
      if (read) await markTimesArticleUnread(news.id, news.issueDate, userId);
      else await markTimesArticleRead(news.id, news.issueDate, userId);
      setReadNotice(read ? "已标为未读" : "已标为已读");
    } catch (reason) {
      setReadNotice(reason instanceof Error ? reason.message : String(reason));
    }
  }

  const content = (
    <div className="mx-auto w-full max-w-4xl px-5 pb-16 pt-6 md:px-10 lg:px-12 lg:pt-10 xl:px-16">
      <Link to="/times" className="mb-5 inline-block font-sans text-xs font-bold text-red lg:hidden">← 返回文章列表</Link>
      {error ? <div role="alert" className="border-2 border-red bg-paper p-5 font-sans text-sm text-red">{error}</div> : null}
      {!news && !error ? <p className="font-sans text-sm text-muted">正在读取全文和图片…</p> : null}
      {news ? (
        <article>
          <p className="font-sans text-[10px] font-black tracking-[0.12em] text-red">
            {news.source.name} · {new Intl.DateTimeFormat("zh-CN", { dateStyle: "long", timeStyle: "short" }).format(new Date(news.publishedAt))}
          </p>
          <div className="mt-3 flex items-center gap-3 font-sans text-[10px]">
            <button type="button" onClick={() => void toggleRead()} className="border border-rule bg-paper px-2.5 py-1 font-bold text-red">{read ? "标为未读" : "标为已读"}</button>
            {readNotice ? <span role="status" className="text-muted">{readNotice}</span> : null}
          </div>
          <h1 className="mt-4 text-3xl font-black leading-tight xl:text-4xl">{news.title}</h1>
          <SelectableAnnotationArticle subject={{
            contentType: "newspaper",
            contentId: news.id,
            sectionId: "body",
            contentTitle: news.title,
            contentUrl: window.location.pathname,
          }} onExplain={startExplanation}>
            {articleHtml ? (
              <div
                className="prose-editorial mt-8 text-base leading-8 [&_blockquote]:border-l-2 [&_blockquote]:border-red [&_blockquote]:pl-5 [&_figcaption]:mt-2 [&_figcaption]:font-sans [&_figcaption]:text-xs [&_figcaption]:leading-5 [&_figcaption]:text-muted [&_figure]:my-8 [&_h2]:mb-3 [&_h2]:mt-9 [&_h2]:text-2xl [&_h2]:font-black [&_img]:mx-auto [&_img]:max-h-[70vh] [&_img]:max-w-full [&_img]:object-contain [&_p]:my-[1.1em] [&_p]:text-justify [&_p]:indent-[2em]"
                dangerouslySetInnerHTML={{ __html: articleHtml }}
              />
            ) : <div className="mt-8 whitespace-pre-wrap text-base leading-8">{news.content || "暂无正文。"}</div>}
          </SelectableAnnotationArticle>
          {originalUrl ? <a className="mt-8 inline-block border-b border-red font-sans text-xs font-bold text-red" href={originalUrl} target="_blank" rel="noreferrer">查看出版方原文 ↗</a> : null}
        </article>
      ) : null}
    </div>
  );

  const page = embedded
    ? <div className="min-h-0 flex-1 overflow-y-auto bg-paper">{content}</div>
    : <main className="min-h-[calc(100vh-64px)] bg-paper text-ink">{content}</main>;
  return <>{page}{explanation ? <TimesExplanationPanel {...explanation} onClose={closeExplanation} /> : null}</>;
}
