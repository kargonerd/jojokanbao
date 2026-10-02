import { useEffect, useState } from "react";
import {
  ARCHIVE_PUBLICATION_BY_ID, loadArchiveIssueKeys, loadArchivePdfCalendar,
  type ArchivePublicationName, type JojoAdaptiveCalendar,
} from "@jojo/content";
import { archiveClient } from "./archiveClient";

/**
 * Group magazine item keys ("196419" → year 1964, seq 19) into the per-year
 * issue lists the picker needs, derived from the Delivery dataset index so a
 * published backfill is offered without a frontend config change.
 */
export function yearSeqMapFromItemKeys(itemKeys: string[]): Record<string, number[]> {
  const map: Record<string, number[]> = {};
  for (const itemKey of itemKeys) {
    if (!/^\d{6}$/.test(itemKey)) continue;
    const year = itemKey.slice(0, 4);
    const seq = Number(itemKey.slice(4));
    const seqs = map[year] ?? (map[year] = []);
    if (!seqs.includes(seq)) seqs.push(seq);
  }
  for (const seqs of Object.values(map)) seqs.sort((a, b) => a - b);
  return map;
}

export interface ArchiveIssueOptionsState {
  /** 杂志：年份 → 升序期数列表。 */
  yearSeqMap: Record<string, number[]>;
  years: string[];
  /** 报纸：PDF 自适应日历（含 startDate/endDate 与每年缺档）。 */
  pdfCalendar: JojoAdaptiveCalendar | null;
  loading: boolean;
  error: string | null;
}

// One in-flight/resolved request per publication; a failed fetch is dropped so
// retry() can start over. Successful results stay cached for the session, and
// archiveClient's resource cache revalidates the underlying objects.
const cache = new Map<ArchivePublicationName, Promise<ArchiveIssueOptionsState>>();

function fetchIssueOptions(publication: ArchivePublicationName): Promise<ArchiveIssueOptionsState> {
  let promise = cache.get(publication);
  if (!promise) {
    promise = (ARCHIVE_PUBLICATION_BY_ID[publication].type === "magazine"
      ? loadArchiveIssueKeys(archiveClient, publication)
      : loadArchivePdfCalendar(archiveClient, publication)
    ).then((data) => {
      if (Array.isArray(data)) {
        const yearSeqMap = yearSeqMapFromItemKeys(data);
        return { yearSeqMap, years: Object.keys(yearSeqMap).sort(), pdfCalendar: null, loading: false, error: null };
      }
      return { yearSeqMap: {}, years: [], pdfCalendar: data, loading: false, error: null };
    });
    cache.set(publication, promise);
    promise.catch(() => cache.delete(publication));
  }
  return promise;
}

export function useArchiveIssueOptions(publication: ArchivePublicationName | null): ArchiveIssueOptionsState & { retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ArchiveIssueOptionsState>({
    yearSeqMap: {}, years: [], pdfCalendar: null, loading: Boolean(publication), error: null,
  });
  useEffect(() => {
    if (!publication) {
      setState({ yearSeqMap: {}, years: [], pdfCalendar: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: null }));
    void fetchIssueOptions(publication).then(
      (options) => { if (!cancelled) setState(options); },
      (error: unknown) => {
        if (cancelled) return;
        setState({
          yearSeqMap: {}, years: [], pdfCalendar: null, loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return () => { cancelled = true; };
  }, [publication, attempt]);
  return { ...state, retry: () => setAttempt((current) => current + 1) };
}
