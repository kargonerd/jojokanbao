import { useEffect, useMemo, useState } from "react";
import { timesSourceLogoPath } from "@jojo/content";
import type { TimesNewsItem } from "../api";

type TimesSource = TimesNewsItem["source"];

export function sourceLogoUrl(source: TimesSource): string | undefined {
  return timesSourceLogoPath(source.id, import.meta.env.BASE_URL);
}

function logoCandidates(source: TimesSource): string[] {
  const override = sourceLogoUrl(source);
  return override ? [override] : [];
}

export function SourceLogo({
  article,
  source: providedSource,
  size = "list",
}: {
  article?: TimesNewsItem;
  source?: TimesSource;
  size?: "list" | "header" | "rail";
}) {
  const source = article?.source || providedSource;
  if (!source) throw new Error("SourceLogo requires an article or source");
  const candidates = useMemo(() => logoCandidates(source), [source]);
  const [candidateIndex, setCandidateIndex] = useState(0);
  useEffect(() => setCandidateIndex(0), [source.id]);

  const dimensions = size === "rail" ? "h-6 w-6" : size === "header" ? "h-7 w-7" : "h-10 w-10";
  const src = candidates[candidateIndex];
  const isCroppedClsWordmark = source.id === "cls" && candidateIndex === 0;
  if (src) {
    return (
      <span className={`flex shrink-0 items-center overflow-hidden ${isCroppedClsWordmark ? "justify-start" : "justify-center"} ${dimensions}`}>
        <img
          data-source-logo={source.id}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setCandidateIndex((value) => value + 1)}
          className={isCroppedClsWordmark ? "h-full w-auto max-w-none shrink-0" : "h-full w-full object-contain"}
        />
      </span>
    );
  }

  return (
    <span aria-hidden="true" className={`shrink-0 ${dimensions}`} />
  );
}
