import type { JojoAssetDescriptor } from "@jojo/content";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { timesApi, type TimesNewsItem } from "../api";
import { SourceLogo } from "./SourceLogo";

function exactArticleTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "时间未知" : new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function relativeArticleTime(value: string): string {
  const timestamp = new Date(value).valueOf();
  if (Number.isNaN(timestamp)) return "时间未知";
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return "刚刚";
  if (elapsedMinutes < 60) return `${elapsedMinutes}分钟前`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}小时前`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}天前`;
  if (elapsedDays < 30) return `${Math.floor(elapsedDays / 7)}周前`;
  if (elapsedDays < 365) return `${Math.floor(elapsedDays / 30)}个月前`;
  return `${Math.floor(elapsedDays / 365)}年前`;
}

function leadImage(article: TimesNewsItem): JojoAssetDescriptor | undefined {
  return article.assets.find((asset) => asset.type === "image" && asset.role === "lead")
    ?? article.assets.find((asset) => asset.type === "image");
}

function TimelineLeadImage({
  article,
  asset,
  onUnavailable,
}: {
  article: TimesNewsItem;
  asset: JojoAssetDescriptor;
  onUnavailable(): void;
}) {
  const frame = useRef<HTMLAnchorElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    const controller = new AbortController();
    let active = true;
    let objectUrl: string | undefined;

    const load = () => {
      if (objectUrl || controller.signal.aborted) return;
      void timesApi.assetObjectUrl(asset, controller.signal).then((value) => {
        if (!active) {
          URL.revokeObjectURL(value);
          return;
        }
        objectUrl = value;
        setUrl(value);
      }).catch((error: unknown) => {
        if (active && !(error instanceof DOMException && error.name === "AbortError")) onUnavailable();
      });
    };

    const observer = typeof IntersectionObserver === "undefined"
      ? undefined
      : new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            load();
            observer?.disconnect();
          }
        }, { rootMargin: "600px 0px" });
    if (observer) observer.observe(node);
    else load();

    return () => {
      active = false;
      controller.abort();
      observer?.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset, onUnavailable]);

  return (
    <Link
      ref={frame}
      to={`/times/${article.issueDate}/${encodeURIComponent(article.id)}`}
      aria-label={`打开：${article.title}`}
      className="relative col-start-3 row-start-1 aspect-[4/3] w-24 self-center overflow-hidden border-l-2 border-red bg-[var(--app-canvas)] focus:outline-none focus-visible:ring-2 focus-visible:ring-red xl:w-28"
    >
      {url ? (
        <img
          src={url}
          alt={asset.alt || ""}
          loading="lazy"
          decoding="async"
          onError={onUnavailable}
          className="h-full w-full object-cover motion-safe:transition-transform motion-safe:duration-300 group-hover:scale-[1.02] motion-reduce:transform-none"
        />
      ) : null}
    </Link>
  );
}

export function TimelineArticle({
  article,
  active = false,
  read = false,
  onToggleRead,
}: {
  article: TimesNewsItem;
  active?: boolean;
  read?: boolean;
  onToggleRead?(): void;
}) {
  const asset = leadImage(article);
  const [imageAvailable, setImageAvailable] = useState(Boolean(asset));
  const markUnavailable = useCallback(() => setImageAvailable(false), []);

  useEffect(() => setImageAvailable(Boolean(asset)), [asset]);

  return (
    <article data-read={read ? "true" : "false"} className={`group grid items-start gap-x-3 border-b border-rule px-3 py-3 transition-colors sm:px-4 ${active ? "border-l-4 border-l-red bg-[color-mix(in_srgb,var(--color-red)_5%,var(--color-paper))] pl-2 sm:pl-3" : "border-l-4 border-l-transparent bg-paper hover:bg-[var(--app-canvas)]"} ${read ? "text-muted" : "text-ink"} ${asset && imageAvailable ? "grid-cols-[40px_minmax(0,1fr)_auto]" : "grid-cols-[40px_minmax(0,1fr)]"}`}>
      <div className="col-start-1 row-start-1 flex flex-col items-center gap-2">
        <SourceLogo article={article} />
        {onToggleRead ? (
          <button
            type="button"
            onClick={onToggleRead}
            aria-label={read ? `将“${article.title}”标为未读` : `将“${article.title}”标为已读`}
            title={read ? "标为未读" : "标为已读"}
            className="grid h-7 w-7 place-items-center border-0 bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-red"
          >
            <span aria-hidden="true" className={`h-2.5 w-2.5 border ${read ? "border-muted bg-transparent" : "border-red bg-red"}`} />
          </button>
        ) : null}
      </div>
      <Link to={`/times/${article.issueDate}/${encodeURIComponent(article.id)}`} className="min-w-0 text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-red">
        <span className="flex min-w-0 items-center gap-2 font-sans text-[10px] font-bold text-muted">
          <span className="truncate text-red">{article.source.name}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={article.publishedAt} title={exactArticleTime(article.publishedAt)} className="shrink-0 tabular-nums">{relativeArticleTime(article.publishedAt)}</time>
          {article.publisherSections?.slice(0, 1).map((section) => <span key={section.id} className="truncate">· {section.name}</span>)}
        </span>
        <strong
          className={`mt-1 overflow-hidden text-[15px] leading-5 transition-colors group-hover:text-red ${read ? "font-medium text-muted" : "font-black text-ink"}`}
          style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2 }}
        >
          {article.title}
        </strong>
        {article.summary ? (
          <span
            className="mt-1 overflow-hidden text-xs leading-[18px] text-muted"
            style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 3 }}
          >
            {article.summary}
          </span>
        ) : null}
      </Link>
      {asset && imageAvailable ? <TimelineLeadImage article={article} asset={asset} onUnavailable={markUnavailable} /> : null}
    </article>
  );
}
