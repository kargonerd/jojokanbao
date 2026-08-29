import { useEffect, useState } from "react";
import { loadBookCoverUrl } from "../rag/content";

const loadedCoverUrls = new Map<string, string>();

export function BookCover({
  className = "library-cover",
  title,
  tone,
  datasetId,
  itemKey,
}: {
  className?: string;
  title: string;
  tone: string;
  datasetId: string;
  itemKey?: string;
}) {
  const cacheKey = `${datasetId}:${itemKey ?? ""}`;
  const [imageUrl, setImageUrl] = useState(() => loadedCoverUrls.get(cacheKey) ?? "");
  const [loaded, setLoaded] = useState(() => loadedCoverUrls.has(cacheKey));

  useEffect(() => {
    const cached = loadedCoverUrls.get(cacheKey);
    if (cached) {
      setImageUrl(cached);
      setLoaded(true);
      return;
    }
    let active = true;
    setImageUrl("");
    setLoaded(false);
    void loadBookCoverUrl(datasetId, itemKey).then((url) => {
      if (!active) return;
      if (url) {
        loadedCoverUrls.set(cacheKey, url);
        setImageUrl(url);
      }
      setLoaded(true);
    }).catch(() => {
      if (active) setLoaded(true);
    });
    return () => { active = false; };
  }, [cacheKey, datasetId, itemKey]);

  return (
    <div className={`${className} book-cover book-cover-${tone}${imageUrl ? " has-image" : loaded ? "" : " is-loading"}`}>
      {imageUrl ? <img src={imageUrl} alt="" /> : loaded ? <b>{title}</b> : null}
    </div>
  );
}
