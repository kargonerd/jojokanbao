import { useEffect, useState } from "react";
import {
  ARCHIVE_CDN_ORIGIN, JoxClient, ResourceCache, browserContentCache, loadArchivePdf,
  type ArchivePdfSource, type ArchivePublicationName,
} from "@jojo/content";

const client = new JoxClient(
  import.meta.env.VITE_CONTENT_CDN_BASE || ARCHIVE_CDN_ORIGIN,
  (input, init) => fetch(input, init),
  new ResourceCache(browserContentCache()),
);

interface State {
  key: string;
  source: ArchivePdfSource | null;
  loading: boolean;
  error: string | null;
}

export function useArchivePdf(publication: ArchivePublicationName, issueId: string) {
  const key = `${publication}:${issueId}`;
  const [state, setState] = useState<State>({ key, source: null, loading: Boolean(issueId), error: null });
  useEffect(() => {
    const controller = new AbortController();
    setState({ key, source: null, loading: Boolean(issueId), error: null });
    if (issueId) {
      void loadArchivePdf(client, publication, issueId, controller.signal).then(
        (source) => { if (!controller.signal.aborted) setState({ key, source, loading: false, error: null }); },
        (error: unknown) => {
          if (!controller.signal.aborted) setState({ key, source: null, loading: false, error: error instanceof Error ? error.message : String(error) });
        },
      );
    }
    return () => controller.abort();
  }, [key, publication, issueId]);
  // Clear the previous issue synchronously, before effects or requests can run.
  return state.key === key ? state : { key, source: null, loading: Boolean(issueId), error: null };
}
