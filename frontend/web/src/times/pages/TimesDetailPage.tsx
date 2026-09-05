import DOMPurify from "dompurify";
import { createElement, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { SelectableAnnotationArticle } from "../../annotations/SelectableAnnotationArticle";
import type { TextAnchor } from "../../annotations/types";
import { ReadingLoadingState } from "../../reading/ReadingLoadingState";
import { SpeechPlayer } from "../../reading/SpeechPlayer";
import { speechSegments } from "../../reading/speech";
import { explainTimesSelection, type TimesExplanationMetadata } from "../ai";
import { timesApi, type TimesNewsItem } from "../api";
import { exactArticleTime, publisherUpdatedAt } from "../articleTime";
import { TimesExplanationPanel } from "../components/TimesExplanationPanel";
import { TimesImageCarousel, type TimesCarouselItem } from "../components/TimesImageCarousel";
import { sourceLogoUrl } from "../components/SourceLogo";
import type { TimesForeignContentLanguage } from "../language";
import { useTimesPreferencesStore } from "../preferencesStore";
import { markTimesArticleRead } from "../readStore";
import { timesSourceName } from "../sourceNames";

function safeNewsUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function materializeAssets(news: TimesNewsItem): ReactNode[] | null {
  const htmlVoidElements = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
  ]);
  if (!news.content || news.contentFormat !== "html") return null;
  // Sanitize publisher HTML before adding object URLs that were created from
  // our own decoded Delivery objects. DOMPurify intentionally removes blob:
  // URLs, so adding the trusted image nodes before sanitizing would make every
  // archived image disappear.
  const safeContent = DOMPurify.sanitize(news.content, { ADD_ATTR: ["data-asset-id"] });
  const document = new DOMParser().parseFromString(safeContent, "text/html");
  for (const paragraph of document.body.querySelectorAll("p")) {
    const trimLeadingPublisherWhitespace = (node: Node): boolean => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === 3) {
          const value = child.textContent ?? "";
          const trimmed = value.replace(/^[\s\u00a0\u3000]+/u, "");
          if (trimmed !== value) child.textContent = trimmed;
          if (trimmed) return true;
        } else if (child.nodeType === 1 && trimLeadingPublisherWhitespace(child)) {
          return true;
        }
      }
      return false;
    };
    trimLeadingPublisherWhitespace(paragraph);
  }
  const assets = new Map(news.assets.map((asset) => [asset.id, asset]));
  const figureCaptions = new Map<string, string>();
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
    const caption = figure.querySelector("figcaption")?.textContent?.replace(/\s+/gu, " ").trim();
    if (caption) figureCaptions.set(asset.id, caption);
  }
  const figures = [...document.body.querySelectorAll<HTMLElement>(":scope > figure[data-asset-id]")];
  const bodyChildren = [...document.body.children];
  const firstFigureIndex = bodyChildren.findIndex((element) => element === figures[0]);
  const allFiguresAreTrailing = figures.length > 1
    && firstFigureIndex >= 0
    && bodyChildren.slice(firstFigureIndex).every((element) => element.matches("figure[data-asset-id]"));
  if (allFiguresAreTrailing) {
    // Older delivery objects lost publisher image positions and appended every
    // content image at the end. Spread only those legacy trailing runs through
    // the article; newly captured objects already carry exact figure anchors.
    const blocks = [...document.body.querySelectorAll<HTMLElement>(":scope > p, :scope > h2, :scope > h3, :scope > h4, :scope > blockquote, :scope > ol, :scope > pre, :scope > ul")];
    if (blocks.length > figures.length) {
      figures.forEach((figure, index) => {
        const target = Math.max(0, Math.round(((index + 1) * blocks.length) / (figures.length + 1)) - 1);
        blocks[target]?.after(figure);
      });
    }
  }

  const carouselGroups = new Map<string, TimesCarouselItem[]>();
  for (const asset of news.assets) {
    const presentation = asset.presentation;
    const url = news.assetUrls?.[asset.id];
    if (presentation?.type !== "carousel" || !url) continue;
    carouselGroups.set(presentation.id, [
      ...(carouselGroups.get(presentation.id) ?? []),
      { asset, url, ...(figureCaptions.get(asset.id) ? { caption: figureCaptions.get(asset.id) } : {}) },
    ]);
  }
  for (const items of carouselGroups.values()) {
    items.sort((left, right) => left.asset.presentation!.order - right.asset.presentation!.order);
  }
  const renderedCarousels = new Set<string>();

  const renderNode = (node: Node, key: string): ReactNode => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return null;
    const element = node as HTMLElement;
    const tag = element.tagName.toLowerCase();
    if (tag === "figure" && element.dataset.assetId) {
      const asset = assets.get(element.dataset.assetId);
      if (!asset) return null;
      const presentation = asset.presentation;
      if (presentation?.type === "carousel") {
        if (renderedCarousels.has(presentation.id)) return null;
        renderedCarousels.add(presentation.id);
        const items = carouselGroups.get(presentation.id) ?? [];
        if (items.length > 1) {
          return <TimesImageCarousel key={`${news.id}:${presentation.id}`} id={presentation.id} items={items} />;
        }
      }
      const url = news.assetUrls?.[asset.id];
      if (!url) return null;
      const caption = figureCaptions.get(asset.id) || asset.caption;
      return (
        <figure key={key} data-asset-id={asset.id}>
          <img src={url} alt={asset.alt || asset.caption || ""} loading="lazy" decoding="async" />
          {caption ? <figcaption>{caption}</figcaption> : null}
        </figure>
      );
    }
    const props: Record<string, unknown> = { key };
    for (const attribute of [...element.attributes]) {
      if (attribute.name === "style") continue;
      const name = attribute.name === "class" ? "className" : attribute.name === "tabindex" ? "tabIndex" : attribute.name;
      props[name] = attribute.value;
    }
    if (htmlVoidElements.has(tag)) return createElement(tag, props);
    return createElement(tag, props, [...element.childNodes].map((child, index) => renderNode(child, `${key}.${index}`)));
  };

  return [...document.body.childNodes].map((node, index) => renderNode(node, `body.${index}`));
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
  const [miniPlayerTarget, setMiniPlayerTarget] = useState<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const languagePreference = useTimesPreferencesStore((state) => state.foreignContentLanguage);
  const articleKey = `${issueDate}:${newsId}`;
  const [languageOverride, setLanguageOverride] = useState<{
    articleKey: string;
    language: TimesForeignContentLanguage;
  }>();
  const requestedLanguage = languageOverride?.articleKey === articleKey
    ? languageOverride.language
    : languagePreference;
  const [explanation, setExplanation] = useState<{
    anchor: TextAnchor;
    answer: string;
    status: string;
    error: string;
    metadata?: TimesExplanationMetadata;
  }>();
  const cancelExplanation = useRef<() => void>(() => {});
  const originalUrl = safeNewsUrl(news?.url);
  const updatedAt = news ? publisherUpdatedAt(news) : undefined;
  const translationUpdatePending = Boolean(
    updatedAt && news?.usingTranslation && news.translations?.["zh-CN"]?.stale,
  );
  const articleBody = useMemo(() => news ? materializeAssets(news) : null, [news]);
  const spokenArticle = useMemo(() => news
    ? speechSegments(news.title, news.content || "", news.contentFormat || "text")
    : [], [news]);
  const speechArtworkUrl = useMemo(() => {
    const images = news?.assets.filter((asset) => asset.type === "image" && news.assetUrls?.[asset.id]) ?? [];
    const artwork = images.find((asset) => asset.role === "lead") ?? images[0];
    return artwork ? news?.assetUrls?.[artwork.id] : undefined;
  }, [news]);

  useEffect(() => {
    let active = true;
    let urls: string[] = [];
    setNews(null);
    setError(null);
    cancelExplanation.current();
    setExplanation(undefined);
    void timesApi.getNews(issueDate, newsId, requestedLanguage).then((value) => {
      urls = Object.values(value.assetUrls ?? {});
      if (active) {
        setNews(value);
        if (markReadOnOpen) markTimesArticleRead(value.id);
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
  }, [issueDate, markReadOnOpen, newsId, requestedLanguage]);

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
      onDone(metadata, answer) {
        setExplanation((current) => current ? { ...current, answer, status: "解释完成", metadata } : current);
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

  const content = (
    <div className="mx-auto w-full max-w-4xl px-5 pb-16 pt-6 md:px-10 lg:px-12 lg:pt-10 xl:px-16">
      {error ? <div role="alert" className="border-2 border-red bg-paper p-5 font-sans text-sm text-red">{error}</div> : null}
      {!news && !error ? <ReadingLoadingState kind="times" status="正在读取全文和图片…" spacingClassName="px-0 py-4" /> : null}
      {news ? (
        <article>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 font-sans">
            <p className="m-0 min-w-0 max-w-full text-[10px] font-bold leading-5 tracking-[0.08em] text-muted">
              <span className="font-black text-red">{timesSourceName(news.source)}</span>
              <span aria-hidden="true"> · </span>
              <span>发布于 <time dateTime={news.publishedAt}>{exactArticleTime(news.publishedAt)}</time></span>
              {updatedAt ? (
                <span className="font-black text-red">
                  <span aria-hidden="true"> · </span>
                  更新于 <time dateTime={updatedAt}>{exactArticleTime(updatedAt)}</time>
                </span>
              ) : null}
            </p>
            {news.usingTranslation ? (
              <span title="此内容由 AI 翻译" className="border border-red/40 px-1.5 py-0.5 text-[9px] font-black tracking-[0.1em] text-red">
                AI 翻译
              </span>
            ) : null}
            {news.translationAvailable ? (
              <button
                type="button"
                onClick={() => setLanguageOverride({
                  articleKey,
                  language: news.usingTranslation ? "original" : "zh-CN",
                })}
                className="border-b border-red text-[10px] font-bold text-red hover:text-ink"
              >
                {news.usingTranslation ? "查看原文" : "查看中文译文"}
              </button>
            ) : null}
          </div>
          {translationUpdatePending ? (
            <p role="status" className="mt-3 border-l-2 border-red pl-3 font-sans text-xs leading-5 text-muted">
              原文已更新，中文译文正在同步。
            </p>
          ) : null}
          <h1 className="mt-4 text-3xl font-black leading-tight xl:text-4xl">{news.title}</h1>
          <SpeechPlayer
            contentId={`news:${articleKey}`}
            miniPlayerTarget={embedded ? miniPlayerTarget : null}
            segments={spokenArticle}
            label="听新闻"
            title={news.title}
            collectionTitle={timesSourceName(news.source)}
            artworkUrl={speechArtworkUrl}
            artworkFallbackUrl={sourceLogoUrl(news.source)}
            defaultVoice="zh-CN-YunyangNeural"
          />
          <SelectableAnnotationArticle subject={{
            contentType: "newspaper",
            contentId: news.id,
            sectionId: "body",
            contentTitle: news.title,
            contentUrl: window.location.pathname,
          }} onExplain={startExplanation}>
            {articleBody ? (
              <div
                className="times-article-body prose-editorial mt-8 text-base leading-8 [&_a]:border-b [&_a]:border-red [&_a]:font-black [&_a]:!text-red [&_a]:no-underline [&_a]:transition-colors [&_a:hover]:bg-red/[0.06] [&_a:focus-visible]:outline [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-red [&_blockquote]:border-l-2 [&_blockquote]:border-red [&_blockquote]:pl-5 [&_figcaption]:mt-2 [&_figcaption]:font-sans [&_figcaption]:text-xs [&_figcaption]:leading-5 [&_figcaption]:text-muted [&_figure]:my-8 [&_h2]:mb-3 [&_h2]:mt-9 [&_h2]:text-2xl [&_h2]:font-black [&_h3]:mb-3 [&_h3]:mt-8 [&_h3]:text-xl [&_h3]:font-black [&_hr]:my-7 [&_hr]:h-px [&_hr]:border-0 [&_hr]:bg-rule [&_img]:mx-auto [&_img]:h-auto [&_img]:max-h-[70vh] [&_img]:max-w-full [&_img]:object-contain [&_li]:my-2 [&_ol]:my-5 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-[1.1em] [&_p]:text-justify [&_p]:indent-[2em] [&_ul]:my-5 [&_ul]:list-disc [&_ul]:pl-6"
              >{articleBody}</div>
            ) : <div className="mt-8 whitespace-pre-wrap text-base leading-8">{news.content || "暂无正文。"}</div>}
          </SelectableAnnotationArticle>
          {originalUrl ? <a className="mt-8 inline-block border-b border-red font-sans text-xs font-bold text-red" href={originalUrl} target="_blank" rel="noreferrer">查看出版方原文 ↗</a> : null}
        </article>
      ) : null}
    </div>
  );

  const page = embedded
    ? <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-paper">
        <div className="min-h-0 flex-1 overflow-y-auto lg:overscroll-y-contain" data-times-article-scroll>{content}</div>
        <div ref={setMiniPlayerTarget} className="relative shrink-0" data-times-speech-dock />
      </div>
    : <main className="min-h-[calc(100vh-64px)] bg-paper text-ink">{content}</main>;
  return <>{page}{explanation ? <TimesExplanationPanel {...explanation} onClose={closeExplanation} /> : null}</>;
}
