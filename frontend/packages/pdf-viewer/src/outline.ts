import type { PDFDocumentProxy } from "pdfjs-dist";
import { normalizePdfSearchText, type PdfOutlinePosition } from "./searchText";

export interface PdfOutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items: PdfOutlineItem[];
}

export interface PdfOutlineLocation {
  page: number;
  position?: PdfOutlinePosition;
}

/** Shared by manual bookmark navigation and automatic search location. */
export async function resolvePdfOutlineDestination(
  document: PDFDocumentProxy,
  dest: PdfOutlineItem["dest"],
  expectedPage?: number,
): Promise<PdfOutlineLocation | null> {
  try {
    const destination = typeof dest === "string" ? await document.getDestination(dest) : dest;
    if (!Array.isArray(destination) || !destination.length) return null;
    const ref = destination[0];
    const index = Number.isInteger(ref) ? Number(ref)
      : ref && typeof ref === "object" ? await document.getPageIndex(ref) : NaN;
    const page = index + 1;
    if (!Number.isSafeInteger(page) || page < 1 || page > document.numPages
      || (expectedPage !== undefined && page !== expectedPage)) return null;

    const location: PdfOutlineLocation = { page };
    const mode = destination[1]?.name;
    const pdfTop = mode === "XYZ" ? destination[3]
      : mode === "FitH" || mode === "FitBH" ? destination[2]
        : mode === "FitR" ? destination[5] : null;
    const pdfLeft = mode === "XYZ" || mode === "FitR" ? destination[2] : null;
    if (typeof pdfTop !== "number" || !Number.isFinite(pdfTop)) return location;
    const pdfPage = await document.getPage(page);
    const viewport = pdfPage.getViewport({ scale: 1 });
    const hasLeft = typeof pdfLeft === "number" && Number.isFinite(pdfLeft);
    // A rotated page needs both coordinates to identify a vertical position.
    if (viewport.rotation % 180 && !hasLeft) return location;
    const [x, y] = viewport.convertToViewportPoint(hasLeft ? pdfLeft : (pdfPage.view?.[0] ?? 0), pdfTop);
    const top = y / viewport.height;
    const left = hasLeft ? x / viewport.width : undefined;
    if (!Number.isFinite(top) || top < 0 || top > 1
      || (left !== undefined && (!Number.isFinite(left) || left < 0 || left > 1))) return location;
    location.position = { top, ...(left !== undefined ? { left } : {}) };
    return location;
  } catch {
    return null;
  }
}

/** Only an unambiguous, complete title on the requested edition can override text location. */
export async function findPdfOutlineLocation(
  document: PDFDocumentProxy,
  items: PdfOutlineItem[],
  title: string,
  page: number,
): Promise<PdfOutlineLocation | null> {
  const needle = normalizePdfSearchText(title);
  if (!needle) return null;
  const candidates: PdfOutlineItem[] = [];
  const visit = (rows: PdfOutlineItem[]) => {
    for (const row of rows) {
      if (row.dest !== null && normalizePdfSearchText(row.title) === needle) candidates.push(row);
      visit(row.items ?? []);
    }
  };
  visit(items);
  const locations = await Promise.all(candidates.map((item) => resolvePdfOutlineDestination(document, item.dest, page)));
  const unique = new Map<string, PdfOutlineLocation>();
  for (const location of locations) {
    if (location?.position) unique.set(JSON.stringify(location), location);
  }
  return unique.size === 1 ? [...unique.values()][0]! : null;
}
