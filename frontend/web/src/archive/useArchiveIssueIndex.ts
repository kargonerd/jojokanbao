import { useEffect, useState } from "react";
import { loadArchiveIssueKeys, type ArchivePublicationName } from "@jojo/content";
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

export interface ArchiveIssueIndexState {
  yearSeqMap: Record<string, number[]>;
  years: string[];
  loading: boolean;
  error: string | null;
}

// One in-flight/resolved request per publication; a failed fetch is dropped so
// retry() can start over. Successful results stay cached for the session, and
// archiveClient's resource cache revalidates the underlying objects.
const cache = new Map<ArchivePublicationName, Promise<string[]>>();

function fetchIssueKeys(publication: ArchivePublicationName): Promise<string[]> {
  let promise = cache.get(publication);
  if (!promise) {
    promise = loadArchiveIssueKeys(archiveClient, publication);
    cache.set(publication, promise);
    promise.catch(() => cache.delete(publication));
  }
  return promise;
}

export function useArchiveIssueIndex(publication: ArchivePublicationName | null): ArchiveIssueIndexState & { retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ArchiveIssueIndexState>({
    yearSeqMap: {}, years: [], loading: Boolean(publication), error: null,
  });
  useEffect(() => {
    if (!publication) {
      setState({ yearSeqMap: {}, years: [], loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: null }));
    void fetchIssueKeys(publication).then(
      (itemKeys) => {
        if (cancelled) return;
        const yearSeqMap = yearSeqMapFromItemKeys(itemKeys);
        setState({
          yearSeqMap,
          years: Object.keys(yearSeqMap).sort(),
          loading: false,
          error: null,
        });
      },
      (error: unknown) => {
        if (cancelled) return;
        setState({ yearSeqMap: {}, years: [], loading: false, error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => { cancelled = true; };
  }, [publication, attempt]);
  return { ...state, retry: () => setAttempt((current) => current + 1) };
}
