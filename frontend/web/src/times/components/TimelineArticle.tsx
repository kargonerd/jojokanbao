import type { JojoAssetDescriptor } from "@jojo/content";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { timesApi, type TimesNewsItem } from "../api";
import { exactArticleTime, publisherUpdatedAt, relativeArticleTime } from "../articleTime";
import { timesSourceName } from "../sourceNames";
import { SourceLogo } from "./SourceLogo";

function leadImage(article: TimesNewsItem): JojoAssetDescriptor | undefined {
  return article.assets.find((asset) => asset.type === "image" && asset.role === "lead")
    ?? article.assets.find((asset) => asset.type === "image");
}

function TimelineLeadImage({
  article,
  asset,
  read,
  onUnavailable,
}: {
  article: TimesNewsItem;
  asset: JojoAssetDescriptor;
  read: boolean;
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
      className="relative col-start-3 row-start-1 aspect-[4/3] w-24 self-center overflow-hidden bg-[var(--app-canvas)] focus:outline-none focus-visible:ring-2 focus-visible:ring-red xl:w-28"
    >
      {url ? (
        <img
          src={url}
          alt={asset.alt || ""}
          loading="lazy"
          decoding="async"
          onError={onUnavailable}
          className={`h-full w-full object-cover motion-safe:transition-[filter,opacity,transform] motion-safe:duration-300 group-hover:scale-[1.02] motion-reduce:transform-none ${read ? "opacity-55 grayscale-[25%]" : ""}`}
        />
      ) : null}
    </Link>
  );
}

export function TimelineArticle({
  article,
  active = false,
  read = false,
}: {
  article: TimesNewsItem;
  active?: boolean;
  read?: boolean;
}) {
  const asset = leadImage(article);
  const updatedAt = publisherUpdatedAt(article);
  const [imageAvailable, setImageAvailable] = useState(Boolean(asset));
  const markUnavailable = useCallback(() => setImageAvailable(false), []);

  useEffect(() => setImageAvailable(Boolean(asset)), [asset]);

  return (
    <article data-read={read ? "true" : "false"} className={`group grid items-start gap-x-3 border-b border-rule px-3 py-3 transition-colors sm:px-4 ${active ? "border-l-4 border-l-red bg-[color-mix(in_srgb,var(--color-red)_5%,var(--color-paper))] pl-2 sm:pl-3" : "border-l-4 border-l-transparent bg-paper hover:bg-[var(--app-canvas)]"} ${read ? "text-muted" : "text-ink"} ${asset && imageAvailable ? "grid-cols-[40px_minmax(0,1fr)_auto]" : "grid-cols-[40px_minmax(0,1fr)]"}`}>
      <div className="col-start-1 row-start-1 flex flex-col items-center">
        <SourceLogo article={article} />
      </div>
      <Link to={`/times/${article.issueDate}/${encodeURIComponent(article.id)}`} className={`min-w-0 text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-red ${read ? "opacity-60" : ""}`}>
        <span className="flex min-w-0 items-center gap-2 font-sans text-[10px] font-bold text-muted">
          <span className={`min-w-0 flex-1 truncate ${read ? "text-muted" : "text-red"}`}>{timesSourceName(article.source)}</span>
          {article.usingTranslation ? (
            <span title="此内容由 AI 翻译" className="shrink-0 border border-red/35 px-1 py-px text-[8px] font-black tracking-[0.08em] text-red">
              AI 翻译
            </span>
          ) : null}
          {updatedAt ? (
            <span title={`出版方更新于 ${exactArticleTime(updatedAt)}`} className="shrink-0 text-[9px] font-black text-red">
              已更新
            </span>
          ) : null}
          <time dateTime={article.publishedAt} title={exactArticleTime(article.publishedAt)} className="shrink-0 tabular-nums">{relativeArticleTime(article.publishedAt)}</time>
        </span>
        <strong
          className={`mt-1 overflow-hidden text-[15px] leading-5 transition-colors group-hover:text-red ${read ? "font-medium text-muted" : active ? "font-black text-red" : "font-black text-ink"}`}
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
      {asset && imageAvailable ? <TimelineLeadImage article={article} asset={asset} read={read} onUnavailable={markUnavailable} /> : null}
    </article>
  );
}
