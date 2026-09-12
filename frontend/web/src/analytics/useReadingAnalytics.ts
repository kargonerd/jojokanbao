import { useEffect, useMemo } from "react";
import { createReadingAttempt } from "@jojo/analytics";

export function useReadingAnalytics(type: "book" | "periodical", id: string, ready: boolean, failed: boolean) {
  const attempt = useMemo(() => createReadingAttempt(type, id), [type, id]);
  useEffect(() => {
    if (failed) attempt.failed();
    else if (ready) attempt.loaded();
  }, [attempt, ready, failed]);
}
