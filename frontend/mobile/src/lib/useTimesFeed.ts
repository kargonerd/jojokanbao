import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useRef, useState } from "react";
import { AppState } from "react-native";
import { firstTimesTimelineCursor, mobileTimesApi, nextTimesTimelineCursor, updatedTimesArticleCount,
  type MobileTimesFeed, type TimesTimelineCursor } from "./times";
import { useRetryOnFailure } from "./useRetryOnFailure";

export function useTimesFeed(userId: string | undefined) {
  const [feed, setFeed] = useState<MobileTimesFeed | null>(null);
  const [pendingLatest, setPendingLatest] = useState<MobileTimesFeed | null>(null);
  const [nextCursor, setNextCursor] = useState<TimesTimelineCursor | null>(null);
  const [loading, setLoading] = useState(Boolean(userId));
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const current = useRef<MobileTimesFeed | null>(null);
  const generation = useRef(0);
  const morePending = useRef(false);
  const latestRequest = useRef<Promise<MobileTimesFeed> | null>(null);

  function commit(value: MobileTimesFeed) {
    current.current = value;
    setFeed(value);
    const last = value.pages.at(-1);
    const cursor = last ? { dateIndex: value.index.dates.findIndex((date) => date.date === last.date), page: last.page }
      : firstTimesTimelineCursor(value.index);
    setNextCursor(cursor ? nextTimesTimelineCursor(value.index, cursor) : null);
    setPendingLatest(null);
    setError("");
    setLoading(false);
    setLoadingMore(false);
    morePending.current = false;
    mobileTimesApi.saveTimeline(value);
  }

  function latest() {
    if (!latestRequest.current) {
      const task = mobileTimesApi.latestTimeline(true).finally(() => {
        if (latestRequest.current === task) latestRequest.current = null;
      });
      latestRequest.current = task;
    }
    return latestRequest.current;
  }

  async function checkLatest() {
    if (!current.current || AppState.currentState !== "active") return;
    const request = generation.current;
    try {
      const value = await latest();
      if (request !== generation.current || !current.current) return;
      if (value.index.updatedAt > current.current.index.updatedAt
        || updatedTimesArticleCount(current.current.pages, value.pages.flatMap((page) => page.articles)) > 0) {
        setPendingLatest(value);
      }
    } catch { /* Keep both the visible timeline and any already discovered update. */ }
  }

  async function refresh() {
    if (!userId) return;
    const request = ++generation.current;
    setRefreshing(true);
    setLoadingMore(false);
    morePending.current = false;
    try {
      const value = await latest();
      if (request === generation.current) commit(value);
    } catch {
      if (request === generation.current) setError(current.current ? "暂时无法更新，继续显示已缓存的新闻" : "新闻暂时无法加载，请联网后重试");
    } finally {
      if (request === generation.current) { setLoading(false); setRefreshing(false); }
    }
  }
  useRetryOnFailure(Boolean(userId && error && !feed && !refreshing), () => { void refresh(); });

  useFocusEffect(useCallback(() => {
    const request = ++generation.current;
    if (!userId) { current.current = null; setFeed(null); setPendingLatest(null); setLoading(false); return; }
    setRefreshing(false);
    setLoadingMore(false);
    morePending.current = false;
    void (async () => {
      try {
        if (!current.current) {
          setLoading(true);
          const cached = await mobileTimesApi.cachedTimeline();
          if (request !== generation.current) return;
          const initial = cached ?? await mobileTimesApi.latestTimeline();
          if (request !== generation.current) return;
          commit(initial);
        }
        void checkLatest();
      } catch {
        if (request === generation.current) { setLoading(false); setError("新闻暂时无法加载，请联网后重试"); }
      }
    })();
    const timer = setInterval(() => { void checkLatest(); }, 60_000);
    const appState = AppState.addEventListener("change", (state) => { if (state === "active") void checkLatest(); });
    return () => { generation.current++; clearInterval(timer); appState.remove(); };
  }, [userId]));

  async function loadMore() {
    const snapshot = current.current;
    const cursor = nextCursor;
    if (!snapshot || !cursor || morePending.current || refreshing) return;
    const date = snapshot.index.dates[cursor.dateIndex];
    if (!date) return;
    const request = generation.current;
    morePending.current = true; setLoadingMore(true); setError("");
    try {
      const page = await mobileTimesApi.timelinePage(date.date, cursor.page, false, snapshot.index);
      if (request !== generation.current) return;
      const value = { index: snapshot.index, pages: [...snapshot.pages, page] };
      current.current = value; setFeed(value); mobileTimesApi.saveTimeline(value);
      setNextCursor(nextTimesTimelineCursor(snapshot.index, cursor));
    } catch {
      if (request === generation.current) setError("更多新闻暂时无法加载，已缓存的新闻仍可阅读");
    } finally {
      if (request === generation.current) { morePending.current = false; setLoadingMore(false); }
    }
  }

  function applyLatest() {
    if (!pendingLatest) return;
    generation.current++;
    commit(pendingLatest);
    setRefreshing(false);
  }
  return { index: feed?.index ?? null, pages: feed?.pages ?? [], pendingLatest, nextCursor,
    loading, refreshing, loadingMore, error, refresh, loadMore, applyLatest };
}
