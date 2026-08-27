import type { JojoAssetDescriptor } from "@jojo/content";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { timesApi, type TimesNewsItem } from "../api";

function articleTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
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
      className="relative col-start-2 mt-4 block aspect-[16/9] w-full max-w-xl overflow-hidden border-l-4 border-red bg-[var(--app-canvas)] focus:outline-none focus-visible:ring-2 focus-visible:ring-red lg:col-start-3 lg:row-start-1 lg:mt-0 lg:aspect-[16/10] lg:max-w-none"
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

export function TimelineArticle({ article }: { article: TimesNewsItem }) {
  const asset = leadImage(article);
  const [imageAvailable, setImageAvailable] = useState(Boolean(asset));
  const markUnavailable = useCallback(() => setImageAvailable(false), []);

  useEffect(() => setImageAvailable(Boolean(asset)), [asset]);

  return (
    <article className={`group grid grid-cols-[52px_minmax(0,1fr)] border-b border-rule px-3 py-5 last:border-b-0 sm:grid-cols-[72px_minmax(0,1fr)] sm:px-5 lg:gap-5 lg:px-7 lg:py-6 ${asset && imageAvailable ? "lg:grid-cols-[84px_minmax(0,1fr)_220px]" : "lg:grid-cols-[84px_minmax(0,1fr)]"}`}>
      <time className="pt-0.5 font-sans text-[11px] font-bold tabular-nums text-muted">{articleTime(article.publishedAt)}</time>
      <Link to={`/times/${article.issueDate}/${encodeURIComponent(article.id)}`} className="min-w-0 text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-red">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-[10px] font-black uppercase tracking-[0.08em] text-red">
          <span>{article.source.name}</span>
          {article.publisherSections?.slice(0, 2).map((section) => <span key={section.id} className="font-medium normal-case tracking-normal text-muted">{section.name}</span>)}
        </span>
        <strong className="mt-1.5 block text-lg leading-snug transition-colors group-hover:text-red sm:text-xl">{article.title}</strong>
        {article.summary ? <span className="mt-2 line-clamp-2 block text-sm leading-6 text-muted">{article.summary}</span> : null}
      </Link>
      {asset && imageAvailable ? <TimelineLeadImage article={article} asset={asset} onUnavailable={markUnavailable} /> : null}
    </article>
  );
}
