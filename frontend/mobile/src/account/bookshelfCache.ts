import type { MobileBookshelfEntry } from "./accountData";

export interface BookshelfLoadOptions {
  refresh?: boolean;
  onUpdate?: (entries: MobileBookshelfEntry[]) => void;
  onError?: (error: unknown) => void;
}

/** Account snapshots stay outside the public CDN cache and never cross accounts. */
export function createBookshelfCache(options: {
  userId: () => string | undefined;
  storage: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
  loadRemote(userId: string, signal: AbortSignal): Promise<MobileBookshelfEntry[]>;
  writeRemote(userId: string, input: MobileBookshelfEntry & { added: boolean }): Promise<void>;
}) {
  const snapshots = new Map<string, MobileBookshelfEntry[]>();
  const revisions = new Map<string, number>();
  const pending = new Map<string, Promise<MobileBookshelfEntry[]>>();
  let writes = Promise.resolve();
  const key = (userId: string) => `jojo-mobile-bookshelf-v1:${userId}`;
  const currentUser = () => {
    const userId = options.userId();
    if (!userId) throw new Error("请先登录后使用账号功能");
    return userId;
  };
  async function cached(userId: string): Promise<MobileBookshelfEntry[] | undefined> {
    if (snapshots.has(userId)) return snapshots.get(userId);
    try {
      const raw = await options.storage.getItem(key(userId));
      const data: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(data) && data.every((item) => item && typeof item.datasetId === "string"
        && typeof item.itemId === "string" && typeof item.title === "string")) {
        if (!snapshots.has(userId)) snapshots.set(userId, data);
      }
    } catch { /* Storage failure must not block an online read. */ }
    return snapshots.get(userId);
  }
  function save(userId: string, entries: MobileBookshelfEntry[]) {
    snapshots.set(userId, entries);
    writes = writes.then(() => options.storage.setItem(key(userId), JSON.stringify(entries))).catch(() => undefined);
  }
  function refresh(userId: string) {
    const existing = pending.get(userId);
    if (existing) return existing;
    const revision = revisions.get(userId) ?? 0;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error("书架暂时无法同步，继续显示本地内容")); controller.abort(); }, 12_000);
    });
    const task = Promise.race([Promise.resolve().then(() => options.loadRemote(userId, controller.signal)), deadline])
      .then((entries) => {
        if (revision !== (revisions.get(userId) ?? 0)) return snapshots.get(userId) ?? entries;
        save(userId, entries);
        return entries;
      }).finally(() => {
        clearTimeout(timer);
        if (pending.get(userId) === task) pending.delete(userId);
      });
    pending.set(userId, task);
    return task;
  }
  return {
    async load({ refresh: force = false, onUpdate, onError }: BookshelfLoadOptions = {}) {
      const userId = currentUser();
      const snapshot = await cached(userId);
      if (options.userId() !== userId) throw new Error("账号已切换");
      const task = refresh(userId);
      if (snapshot && !force) {
        void task.then((entries) => { if (options.userId() === userId) onUpdate?.(entries); },
          (error) => { if (options.userId() === userId) onError?.(error); });
        return snapshot;
      }
      const entries = await task;
      if (options.userId() !== userId) throw new Error("账号已切换");
      return entries;
    },
    async set(input: MobileBookshelfEntry & { added: boolean }) {
      const userId = currentUser();
      await cached(userId);
      if (options.userId() !== userId) throw new Error("账号已切换");
      revisions.set(userId, (revisions.get(userId) ?? 0) + 1);
      await options.writeRemote(userId, input);
      revisions.set(userId, (revisions.get(userId) ?? 0) + 1);
      pending.delete(userId);
      // Do not persist a partial shelf if its full list has never been loaded.
      const previous = snapshots.get(userId);
      if (previous) {
        const rest = previous.filter((item) => item.datasetId !== input.datasetId || item.itemId !== input.itemId);
        const { added, ...entry } = input;
        save(userId, added ? [entry, ...rest] : rest);
      }
    },
  };
}
