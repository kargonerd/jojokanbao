import { useEffect, useRef, useState } from "react";
import { loadBookCoverUrl } from "../rag/content";

export function BookCover({
  title,
  tone,
  datasetId,
  itemKey,
}: {
  title: string;
  tone: string;
  datasetId: string;
  itemKey?: string;
}) {
  const coverRef = useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [imageUrl, setImageUrl] = useState("");

  useEffect(() => {
    const element = coverRef.current;
    if (!element || shouldLoad) return;
    if (!("IntersectionObserver" in window)) {
      setShouldLoad(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setShouldLoad(true);
      observer.disconnect();
    }, { rootMargin: "180px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [shouldLoad]);

  useEffect(() => {
    if (!shouldLoad) return;
    let active = true;
    let objectUrl = "";
    void loadBookCoverUrl(datasetId, itemKey).then((url) => {
      if (!active || !url) return;
      objectUrl = url;
      setImageUrl(url);
    }).catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [datasetId, itemKey, shouldLoad]);

  return (
    <div ref={coverRef} className={`library-cover book-cover book-cover-${tone}${imageUrl ? " has-image" : ""}`}>
      {imageUrl ? <img src={imageUrl} alt="" /> : <b>{title}</b>}
    </div>
  );
}
