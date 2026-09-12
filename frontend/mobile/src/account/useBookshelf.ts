import { useFocusEffect, useNavigation, type NavigationProp } from "@react-navigation/native";
import { useCallback, useRef, useState } from "react";
import type { RootStackParamList } from "../navigation/types";
import { loadMobileBookshelf, setMobileBookshelf, type MobileBookshelfEntry } from "./accountData";
import { useMobileAuthStore } from "./auth";
import { useRetryOnFailure } from "../lib/useRetryOnFailure";
import { useMobileFeatureFlag } from "../reading/featureFlag";

// One shelf request per focused screen, not one request for every book card.
export function useBookshelf() {
  const enabled = useMobileFeatureFlag("library.bookshelf");
  const userId = useMobileAuthStore((state) => state.user?.id);
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const [entries, setEntries] = useState<MobileBookshelfEntry[]>([]);
  const [loading, setLoading] = useState(Boolean(userId));
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const generation = useRef(0);
  const busy = useRef(false);
  const owner = useRef(userId);
  const [retryToken, setRetryToken] = useState(0);
  const reload = () => setRetryToken((value) => value + 1);
  useRetryOnFailure(Boolean(error) && !loading && !busyKey, reload);

  useFocusEffect(useCallback(() => {
    const request = ++generation.current;
    if (owner.current !== userId) setEntries([]);
    owner.current = userId;
    setError("");
    setLoading(Boolean(userId && enabled));
    setBusyKey("");
    busy.current = false;
    if (userId && enabled) void loadMobileBookshelf({
      onUpdate: (items) => { if (request === generation.current) { setEntries(items); setError(""); } },
      onError: () => { if (request === generation.current) setError("书架暂时无法同步，继续显示本地内容。"); },
    })
      .then((items) => { if (request === generation.current) setEntries(items); })
      .catch(() => { if (request === generation.current) setError("书架状态暂时无法读取，点击书架按钮重试。"); })
      .finally(() => { if (request === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [userId, enabled, retryToken]));

  async function toggle(key: string, resolveEntry: () => Promise<MobileBookshelfEntry | undefined>) {
    if (!enabled) return;
    if (!userId) { navigation.navigate("Account"); return; }
    if (loading || busy.current) return;
    busy.current = true;
    const request = generation.current;
    setBusyKey(key);
    const needsReload = Boolean(error);
    setError("");
    try {
      const current = needsReload ? await loadMobileBookshelf({ refresh: true }) : entries;
      const entry = await resolveEntry();
      if (!entry || request !== generation.current) return;
      const matches = (item: MobileBookshelfEntry) => item.datasetId === entry.datasetId && item.itemId === entry.itemId;
      const added = !current.some(matches);
      await setMobileBookshelf({ ...entry, added });
      if (request === generation.current) setEntries(added ? [entry, ...current.filter((item) => !matches(item))] : current.filter((item) => !matches(item)));
    } catch (reason) {
      if (request === generation.current) setError(reason instanceof Error ? reason.message : "书架操作失败，请重试。");
    } finally {
      if (request === generation.current) { busy.current = false; setBusyKey(""); }
    }
  }

  return { enabled, entries: enabled && owner.current === userId ? entries : [], loading, error, busyKey, toggle, reload };
}
