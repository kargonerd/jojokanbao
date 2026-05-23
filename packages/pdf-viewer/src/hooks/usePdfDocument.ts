import { useState, useEffect, useRef } from "react";
import { getDocument, type PDFDocumentProxy } from "pdfjs-dist";

const CMAP_URL = "https://unpkg.com/pdfjs-dist@5.7.284/cmaps/";

interface UsePdfDocumentOptions {
  url: string;
  cMapUrl?: string;
}

interface PdfDocumentState {
  document: PDFDocumentProxy | null;
  numPages: number;
  loading: boolean;
  error: string | null;
}

export function usePdfDocument({ url, cMapUrl = CMAP_URL }: UsePdfDocumentOptions): PdfDocumentState {
  const [state, setState] = useState<PdfDocumentState>({ document: null, numPages: 0, loading: true, error: null });
  const prevUrl = useRef("");

  useEffect(() => {
    if (!url || url === prevUrl.current) return;
    prevUrl.current = url;

    setState({ document: null, numPages: 0, loading: true, error: null });

    const task = getDocument({ url, cMapUrl, cMapPacked: true });

    task.promise
      .then((doc) => {
        setState({ document: doc, numPages: doc.numPages, loading: false, error: null });
      })
      .catch((err) => {
        if (String(err).includes("Worker was destroyed")) return;
        setState({ document: null, numPages: 0, loading: false, error: String(err?.message || err) });
      });

    return () => { task.destroy().catch(() => {}); };
  }, [url, cMapUrl]);

  return state;
}
