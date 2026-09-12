import { ARCHIVE_PUBLICATION_NAMES, type ArchivePublicationName } from "./archive";

interface ReadingEntry {
  title: string;
  subtitle: string;
  progress: number;
  updatedAt: number;
}
export type ReadingRecord = ReadingEntry & (
  | { kind: "book"; datasetId: string; itemKey: string; chapterId?: string; chapterProgress?: number }
  | { kind: "periodical"; publication: ArchivePublicationName; issueId: string; currentPage: number; totalPages: number }
);
export interface ReadingHistoryData { records: ReadingRecord[]; clearedAt: number }
export interface ReadingHistoryState extends ReadingHistoryData {
  ownerId?: string | null;
  accounts: Record<string, ReadingHistoryData>;
}

export function readingRecordKey(record: ReadingRecord): string {
  return JSON.stringify(record.kind === "book"
    ? [record.kind, record.datasetId, record.itemKey]
    : [record.kind, record.publication, record.issueId]);
}

export function isReadingRecord(value: unknown): value is ReadingRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  const text = (v: unknown, max = 500) => typeof v === "string" && v.length > 0 && v.length <= max;
  const number = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
  if (!text(r.title) || typeof r.subtitle !== "string" || r.subtitle.length > 500
    || !number(r.progress, 0, 100) || !number(r.updatedAt, 1, 8640000000000000)) return false;
  if (r.kind === "book") return text(r.datasetId) && text(r.itemKey)
    && (r.chapterId === undefined || text(r.chapterId))
    && (r.chapterProgress === undefined || number(r.chapterProgress, 0, 1));
  return r.kind === "periodical" && ARCHIVE_PUBLICATION_NAMES.includes(r.publication as ArchivePublicationName)
    && typeof r.issueId === "string" && /^\d{6}(\d{2})?$/.test(r.issueId)
    && number(r.currentPage, 1, 100000) && Number.isInteger(r.currentPage)
    && number(r.totalPages, 0, 100000) && Number.isInteger(r.totalPages);
}

export function mergeReadingHistory(...histories: ReadingHistoryData[]): ReadingHistoryData {
  const clearedAt = Math.max(0, ...histories.map((h) => h.clearedAt || 0));
  const records = new Map<string, ReadingRecord>();
  for (const history of histories) for (const record of history.records) {
    if (!isReadingRecord(record) || record.updatedAt <= clearedAt) continue;
    const key = readingRecordKey(record);
    const previous = records.get(key);
    // On an equal timestamp retain the first input (the current local snapshot).
    if (!previous || previous.updatedAt < record.updatedAt) records.set(key, record);
  }
  return { clearedAt, records: [...records.values()].sort((a, b) =>
    b.updatedAt - a.updatedAt || readingRecordKey(a).localeCompare(readingRecordKey(b))).slice(0, 16) };
}

interface SyncOptions {
  read: () => ReadingHistoryState;
  write: (state: ReadingHistoryState) => void;
  subscribe: (changed: () => void) => () => void;
  account: () => { initialized: boolean; userId: string | null };
  subscribeAccount: (changed: () => void) => () => void;
  exchange: (userId: string, data: ReadingHistoryData, signal: AbortSignal) => Promise<ReadingHistoryData>;
}

/** One bounded account snapshot, persisted by the host's existing local store.
 * Failed writes remain on disk and are retried on the next checkpoint/foreground.
 */
export function startReadingHistorySync(options: SyncOptions) {
  let stopped = false;
  let applying = false;
  let revision = 0;
  let pending: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastData = "";
  const apply = (state: ReadingHistoryState) => {
    applying = true;
    options.write(state);
    lastData = JSON.stringify(options.read());
    applying = false;
  };
  const schedule = () => { if (!timer && !stopped) timer = setTimeout(() => { timer = undefined; void sync(); }, 1500); };
  const sync = async () => {
    const account = options.account();
    const local = options.read();
    if (stopped || pending || !account.initialized || !account.userId || local.ownerId !== account.userId) return;
    const request = new AbortController();
    pending = request;
    const requestRevision = revision;
    const timeout = setTimeout(() => request.abort(), 12000);
    try {
      const remote = await options.exchange(account.userId, mergeReadingHistory(local), request.signal);
      if (stopped || revision !== requestRevision || options.account().userId !== account.userId) return;
      const current = options.read();
      const merged = mergeReadingHistory(remote, current);
      const changedDuringRequest = JSON.stringify(mergeReadingHistory(current)) !== JSON.stringify(mergeReadingHistory(local));
      apply({ ...current, ...merged });
      if (changedDuringRequest) schedule();
    } catch {
      // Local persistence is authoritative while offline. The periodic refresh retries.
    } finally {
      clearTimeout(timeout);
      if (pending === request) pending = undefined;
    }
  };
  const activate = () => {
    const account = options.account();
    if (!account.initialized) return;
    const current = options.read();
    if (current.ownerId !== account.userId) {
      revision++;
      pending?.abort();
      pending = undefined;
      const accounts = { ...current.accounts };
      if (current.ownerId !== undefined) accounts[current.ownerId ?? "guest"] = mergeReadingHistory(current);
      const saved = accounts[account.userId ?? "guest"] ?? { records: [], clearedAt: 0 };
      const guest = { ...mergeReadingHistory(current), clearedAt: 0 };
      const next = current.ownerId === undefined || (current.ownerId === null && account.userId)
        ? mergeReadingHistory(guest, saved) : saved;
      // Claim the guest history once; signing out must never expose account history.
      if (account.userId) delete accounts.guest;
      apply({ ...next, ownerId: account.userId, accounts });
    }
    schedule();
  };
  const stopAccount = options.subscribeAccount(activate);
  const stopLocal = options.subscribe(() => {
    if (applying || JSON.stringify(options.read()) === lastData) return;
    lastData = JSON.stringify(options.read());
    schedule();
  });
  activate();
  // Also pulls reading performed on another device while this app remains open.
  const interval = setInterval(() => { void sync(); }, 30000);
  return {
    refresh: () => { activate(); void sync(); },
    stop: () => {
      stopped = true;
      revision++;
      pending?.abort();
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      stopAccount(); stopLocal();
    },
  };
}
