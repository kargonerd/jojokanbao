import { useEffect, useMemo, useState } from "react";
import type { TimesNewsItem } from "../api";

const SOURCE_LOGO_OVERRIDES: Record<string, string> = {
  "agencia-brasil": "/times/source-logos/agencia-brasil.ico",
  africanews: "/times/source-logos/africanews.png",
  aljazeera: "/times/source-logos/aljazeera.png",
  ap: "/times/source-logos/ap.png",
  axios: "/times/source-logos/axios.png",
  bloomberg: "/times/source-logos/bloomberg.png",
  chinanews: "/times/source-logos/chinanews.jpg",
  cls: "/times/source-logos/cls.png",
  cna: "/times/source-logos/cna.png",
  dw: "/times/source-logos/dw.png",
  "focus-taiwan": "/times/source-logos/focus-taiwan.jpg",
  ft: "/times/source-logos/ft.png",
  guardian: "/times/source-logos/guardian.png",
  nikkei: "/times/source-logos/nikkei.png",
  npr: "/times/source-logos/npr.png",
  nyt: "/times/source-logos/nyt.png",
  people: "/times/source-logos/people.jpg",
  reuters: "/times/source-logos/reuters.png",
  scmp: "/times/source-logos/scmp.png",
  thepaper: "/times/source-logos/thepaper.png",
  xinhua: "/times/source-logos/xinhua.jpg",
  zaobao: "/times/source-logos/zaobao.png",
};

type TimesSource = TimesNewsItem["source"];

function logoCandidates(source: TimesSource): string[] {
  const override = SOURCE_LOGO_OVERRIDES[source.id];
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

  const dimensions = size === "rail" ? "h-6 w-6" : "h-10 w-10";
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
