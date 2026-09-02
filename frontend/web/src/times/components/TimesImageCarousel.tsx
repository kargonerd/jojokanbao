import type { JojoAssetDescriptor } from "@jojo/content";
import { useRef, useState, type KeyboardEvent, type TouchEvent } from "react";

export interface TimesCarouselItem {
  asset: JojoAssetDescriptor;
  url: string;
  caption?: string;
}

function ArrowIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d={direction === "left" ? "m15 5-7 7 7 7" : "m9 5 7 7-7 7"} strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
}

export function TimesImageCarousel({ id, items }: { id: string; items: TimesCarouselItem[] }) {
  const [index, setIndex] = useState(0);
  const touchStartX = useRef<number | null>(null);
  const current = items[index] ?? items[0]!;
  const count = items.length;

  const show = (next: number) => setIndex((next + count) % count);
  const previous = () => show(index - 1);
  const next = () => show(index + 1);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      previous();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      next();
    }
  }

  function onTouchStart(event: TouchEvent<HTMLElement>) {
    touchStartX.current = event.touches[0]?.clientX ?? null;
  }

  function onTouchEnd(event: TouchEvent<HTMLElement>) {
    const start = touchStartX.current;
    touchStartX.current = null;
    const end = event.changedTouches[0]?.clientX;
    if (start === null || end === undefined || Math.abs(end - start) < 42) return;
    if (end < start) next();
    else previous();
  }

  const description = current.caption || current.asset.caption || current.asset.alt || `第 ${index + 1} 张图片`;
  return (
    <figure
      data-carousel-id={id}
      aria-label={`图片轮播，共 ${count} 张`}
      aria-roledescription="轮播图"
      className="times-image-carousel border-y border-rule-dark bg-ink text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="relative flex min-h-[220px] items-center justify-center overflow-hidden sm:min-h-[300px]">
        <img
          key={current.asset.id}
          src={current.url}
          alt={current.asset.alt || current.asset.caption || ""}
          loading={index === 0 ? "eager" : "lazy"}
          decoding="async"
          className="mx-auto max-h-[72vh] w-full object-contain"
        />
        <span aria-live="polite" className="absolute left-3 top-3 bg-ink/80 px-2 py-1 font-sans text-[10px] font-black tabular-nums tracking-[0.08em] text-paper sm:left-4 sm:top-4">
          {index + 1} / {count}
        </span>
        <button type="button" onClick={previous} aria-label="上一张图片" className="absolute left-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center border border-paper/60 bg-ink/75 text-paper hover:border-red hover:bg-red focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-paper sm:left-4">
          <ArrowIcon direction="left" />
        </button>
        <button type="button" onClick={next} aria-label="下一张图片" className="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center border border-paper/60 bg-ink/75 text-paper hover:border-red hover:bg-red focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-paper sm:right-4">
          <ArrowIcon direction="right" />
        </button>
      </div>
      <figcaption className="!mt-0 flex min-h-12 items-start gap-3 border-t border-rule-dark bg-paper px-3 py-2.5 text-ink sm:px-4">
        <span className="shrink-0 font-sans text-[9px] font-black tracking-[0.14em] text-red">图集</span>
        <span className="min-w-0 flex-1 font-sans text-xs leading-5 text-muted">{description}</span>
      </figcaption>
    </figure>
  );
}
