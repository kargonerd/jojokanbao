import { useEffect, useState } from "react";
import { loadArchivePdf, type ArchivePdfSource, type ArchivePublicationName } from "@jojo/content";
import { archiveClient } from "./archiveClient";

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
      void loadArchivePdf(archiveClient, publication, issueId, controller.signal).then(
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
