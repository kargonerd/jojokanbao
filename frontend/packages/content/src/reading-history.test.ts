import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeReadingHistory, startReadingHistorySync, type ReadingHistoryData, type ReadingHistoryState, type ReadingRecord } from "./reading-history";

const book = (updatedAt: number, progress = 50): ReadingRecord => ({ kind: "book", datasetId: "d", itemKey: "i", title: "书", subtitle: "章", updatedAt, progress, chapterId: "c", chapterProgress: progress / 100 });
const data = (...records: ReadingRecord[]): ReadingHistoryData => ({ records, clearedAt: 0 });
afterEach(() => vi.useRealTimers());

describe("reading history merge", () => {
  it("uses the latest reading time, including intentionally moving backwards", () => {
    expect(mergeReadingHistory(data(book(20, 10)), data(book(10, 90))).records).toEqual([book(20, 10)]);
  });
  it("keeps books and periodicals and rejects malformed legacy entries", () => {
    const issue: ReadingRecord = { kind: "periodical", publication: "rmrb", issueId: "19761009", title: "人民日报", subtitle: "", currentPage: 4, totalPages: 6, progress: 0, updatedAt: 30 };
    expect(mergeReadingHistory(data(book(10), issue, { ...book(100), progress: NaN })).records).toEqual([issue, book(10)]);
  });
  it("a clear tombstone removes stale offline uploads but permits later reading", () => {
    expect(mergeReadingHistory({ records: [], clearedAt: 20 }, data(book(10)))).toEqual({ records: [], clearedAt: 20 });
    expect(mergeReadingHistory({ records: [], clearedAt: 20 }, data(book(30)))).toEqual({ records: [book(30)], clearedAt: 20 });
  });
});

function setup(exchange = vi.fn<(user: string, data: ReadingHistoryData, signal: AbortSignal) => Promise<ReadingHistoryData>>().mockImplementation(async (_user, snapshot) => snapshot)) {
  vi.useFakeTimers();
  let state: ReadingHistoryState = { ...data(book(10)), accounts: {} };
  let account = { initialized: false, userId: null as string | null };
  let localChanged = () => {};
  let accountChanged = () => {};
  const sync = startReadingHistorySync({ read: () => state, write: (value) => { state = value; localChanged(); },
    subscribe: (cb) => { localChanged = cb; return () => {}; },
    account: () => account, subscribeAccount: (cb) => { accountChanged = cb; return () => {}; }, exchange });
  return { sync, exchange, read: () => state,
    login: (userId: string | null) => { account = { initialized: true, userId }; accountChanged(); },
    write: (snapshot: ReadingHistoryData) => { state = { ...state, ...snapshot }; localChanged(); } };
}

describe("reading history sync lifecycle", () => {
  it("waits for auth, imports legacy history once, and isolates accounts and guest history", async () => {
    const h = setup();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.exchange).not.toHaveBeenCalled();
    h.login("a");
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.exchange).toHaveBeenCalledWith("a", data(book(10)), expect.any(AbortSignal));
    h.login("b");
    expect(h.read().records).toEqual([]);
    h.login(null);
    expect(h.read().records).toEqual([]);
    h.login("a");
    expect(h.read().records).toEqual([book(10)]);
    h.sync.stop();
  });
  it("retries offline writes without losing local progress", async () => {
    const h = setup();
    h.exchange.mockRejectedValueOnce(new Error("offline"));
    h.login("a");
    await vi.advanceTimersByTimeAsync(1500);
    h.write(data(book(30)));
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.exchange).toHaveBeenLastCalledWith("a", data(book(30)), expect.any(AbortSignal));
    h.sync.stop();
  });
  it("clearing guest history does not clear the account when signing back in", () => {
    const h = setup();
    h.login("a"); h.login(null);
    h.write({ records: [], clearedAt: 50 });
    h.login("a");
    expect(h.read().records).toEqual([book(10)]);
    expect(h.read().clearedAt).toBe(0);
    h.sync.stop();
  });
  it("merges changes made during an upload and ignores a previous account's late response", async () => {
    let resolve!: (data: ReadingHistoryData) => void;
    const h = setup();
    h.exchange.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    h.login("a");
    await vi.advanceTimersByTimeAsync(1500);
    h.write(data(book(40)));
    resolve(data(book(20)));
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.read().records).toEqual([book(40)]);
    h.exchange.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    h.sync.refresh();
    h.login("b");
    resolve(data(book(60)));
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.read().ownerId).toBe("b");
    expect(h.read().records).toEqual([]);
    h.sync.stop();
  });
});
