import type * as React from "react";

interface Page<T> { items: T[]; nextCursor: string | null }
interface State<T> extends Page<T> { key: string; loading: boolean; error: unknown; started: boolean }

/** A cancellable, explicitly paged list shared by native and browser panels. */
export function createUseCursorPages({ useCallback, useEffect, useRef, useState }: Pick<typeof React, "useCallback" | "useEffect" | "useRef" | "useState">) {
  // Bind to the host's React instance; native and web use different renderer versions.
  return function useCursorPages<T extends { id: string }>({ key, enabled, loadPage }: {
    key: string;
    enabled: boolean;
    loadPage: (cursor: string | null, signal: AbortSignal) => Promise<Page<T>>;
  }) {
    const [state, setState] = useState<State<T>>({ key, items: [], nextCursor: null, loading: false, error: null, started: false });
    const scope = useRef({ key, enabled });
    scope.current = { key, enabled };
    const request = useRef<AbortController | undefined>(undefined);
    const failedCursor = useRef<string | null>(null);
    const run = useCallback(async (cursor: string | null) => {
      if (!scope.current.enabled || scope.current.key !== key || request.current) return;
      const controller = new AbortController();
      request.current = controller;
      const isCurrent = () => !controller.signal.aborted && request.current === controller && scope.current.key === key && scope.current.enabled;
      setState((previous) => ({ key, items: cursor && previous.key === key ? previous.items : [], nextCursor: cursor, loading: true, error: null, started: true }));
      try {
        const page = await loadPage(cursor, controller.signal);
        if (!isCurrent()) return;
        setState((previous) => ({ key, items: [...new Map([...(cursor && previous.key === key ? previous.items : []), ...page.items].map((item) => [item.id, item])).values()], nextCursor: page.nextCursor, loading: false, error: null, started: true }));
      } catch (error) {
        if (isCurrent()) { failedCursor.current = cursor; setState((previous) => ({ ...previous, loading: false, error })); }
      } finally { if (request.current === controller) request.current = undefined; }
    }, [key, loadPage]);
    useEffect(() => {
      if (enabled) void run(null);
      return () => { request.current?.abort(); request.current = undefined; };
    }, [key, enabled, run]);
    const visible = enabled && state.key === key;
    return {
      items: visible ? state.items : [],
      loading: visible ? state.loading || !state.started : enabled,
      error: visible ? state.error : null,
      hasMore: visible && state.nextCursor !== null,
      loadMore: () => { if (visible && state.nextCursor) void run(state.nextCursor); },
      retry: () => { void run(failedCursor.current); },
      refresh: () => { request.current?.abort(); request.current = undefined; void run(null); },
    };
  }
}
