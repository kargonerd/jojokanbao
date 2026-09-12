import { createHash } from "node:crypto";
import { gzipSync, strToU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { OfflineBookLibrary, type OfflineBookIdentity, type OfflineBookRecord, type OfflineBookRepository } from "../src/offline-books";
import { offlineIdentityFromStoredSession } from "../src/offline-identity";
import { transformJoxBytes } from "../src/jox";

function fixture(authenticated = false) {
  const objects = new Map<string, Uint8Array>();
  const digest = async (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  function json(object: string, value: unknown) {
    const bytes = strToU8(JSON.stringify(value));
    objects.set(object, transformJoxBytes(gzipSync(bytes), object));
    return { object: object.split("/").slice(2).join("/"), size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  function asset(object: string, value: string) {
    const bytes = strToU8(value);
    objects.set(object, transformJoxBytes(bytes, object));
    return { object: object.split("/").slice(2).join("/"), size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  const photo = { ...asset("books/one/photo.jox", "real photo bytes"), id: "photo", role: "figure", type: "image", mediaType: "image/png" };
  const cover = { ...asset("books/one/cover.jox", "cover bytes"), id: "cover", role: "cover", type: "image", mediaType: "image/png" };
  const chapters = [1, 2].map((number) => ({
    ...json(`books/one/chapter-${number}.jox`, {
      formatVersion: "jojo-fragment/1", itemId: "book:one", fragmentId: `chapter:${number}`, type: "chapter", order: number, title: `第${number}章`,
      body: { format: "html", value: number === 1 ? '<p>正文</p><figure data-asset-id="photo"></figure>' : "<p>第二章</p>" },
      assetRefs: [], annotations: [],
    }), id: `chapter:${number}`, order: number, title: `第${number}章`, characterCount: 3,
  }));
  const search = { ...json("books/one/search.jox", { formatVersion: "jojo-book-search/1", itemId: "book:one", blocks: [{ targetId: "chapter:1", order: 1, text: "正文" }] }), format: "text", profile: "jojo-book-search/1" };
  const manifest = {
    formatVersion: "jojo-item-manifest/1", revision: 1, itemId: "book:one", datasetId: "books", type: "book", title: "一本书", language: "zh", metadata: {},
    ...(authenticated ? { access: "authenticated" } : {}),
    content: { schema: "jojo-content/book/1", chapters }, contentStats: { chapterCount: 2, characterCount: 6 }, assets: [photo, cover], exports: [], search,
  };
  json("books/one/manifest.jox", manifest);
  json("books/index.jox", { formatVersion: "jojo-delivery-index/1", revision: 1, datasetId: "books", type: "book", title: "书籍", language: "zh", items: [{ itemId: "book:one", itemKey: "one", type: "book", title: "一本书", order: 1, manifestObject: "one/manifest.jox" }] });
  json("catalog.jox", { formatVersion: "jojo-catalog/1", revision: 1, updatedAt: "2026-09-08", datasets: [{ datasetId: "books", type: "book", title: "书籍", language: "zh", indexObject: "books/index.jox" }] });
  const records = new Map<string, OfflineBookRecord>();
  const resources = new Map<string, Uint8Array>();
  const key = (book: OfflineBookRecord, object: string) => `${book.id}\0${book.generation}\0${object}`;
  const repository: OfflineBookRepository = {
    list: async () => [...records.values()].map((book) => structuredClone(book)),
    put: async (book) => { records.set(book.id, structuredClone(book)); },
    getResource: async (book, object) => resources.get(key(book, object)),
    putResource: async (book, object, bytes) => { resources.set(key(book, object), bytes.slice()); },
    remove: async (id) => { records.delete(id); for (const key of resources.keys()) if (key.startsWith(`${id}\0`)) resources.delete(key); },
  };
  let identity: OfflineBookIdentity = { initialized: true, userId: authenticated ? "reader-a" : null };
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const object = new URL(String(input)).pathname.slice(1);
    const bytes = objects.get(object);
    return bytes ? new Response(bytes.slice().buffer) : new Response("missing", { status: 404 });
  });
  const options = { repository, baseUrl: "https://content.test/", digest, fetch: fetcher, identity: () => identity };
  return { library: new OfflineBookLibrary(options), options, fetcher, objects, records, resources, manifest, json, setIdentity: (next: OfflineBookIdentity) => { identity = next; } };
}

const request = { datasetId: "books", itemKey: "one" };

describe("managed offline books", () => {
  it("uses an expired local session only for offline identity and invalidates it when that session is removed", () => {
    const current = { initialized: false, userId: null };
    const session = JSON.stringify({ expires_at: 1, user: { id: "reader-a" } });
    expect(offlineIdentityFromStoredSession(current, session, true)).toEqual({ initialized: true, userId: "reader-a" });
    expect(offlineIdentityFromStoredSession(current, session, false)).toEqual(current);
    expect(offlineIdentityFromStoredSession(current, null, true)).toEqual(current);
    expect(offlineIdentityFromStoredSession({ initialized: true, userId: "reader-b" }, session, true).userId).toBe("reader-b");
    expect(offlineIdentityFromStoredSession(current, "invalid", true)).toEqual(current);
  });

  it("persists the complete book and opens after a fresh offline restart, including omitted assetRefs and search", async () => {
    const setup = fixture();
    await setup.library.download(request);
    const [book] = await setup.library.list();
    expect(book).toMatchObject({ status: "ready", completed: 8, total: 8 });
    expect(book!.bytes).toBe([...setup.objects.values()].reduce((sum, bytes) => sum + bytes.length, 0));
    setup.fetcher.mockRejectedValue(new Error("offline"));
    setup.fetcher.mockClear();
    const restarted = new OfflineBookLibrary(setup.options);
    await restarted.recover();
    const opened = await restarted.open("books", "book:one");
    expect(opened?.manifest.title).toBe("一本书");
    await expect(opened!.client.fetchJson("books/one/chapter-2.jox")).resolves.toMatchObject({ fragmentId: "chapter:2" });
    await expect(opened!.client.fetchJson("books/one/search.jox")).resolves.toMatchObject({ itemId: "book:one" });
    const photo = await opened!.client.fetchDecodedBytes("books/one/photo.jox");
    expect(new TextDecoder().decode(photo)).toBe("real photo bytes");
    expect(setup.fetcher).not.toHaveBeenCalled();
  });

  it("never marks missing or corrupt assets ready, and retries an interrupted book from a clean package", async () => {
    const setup = fixture();
    const photo = setup.objects.get("books/one/photo.jox")!;
    setup.objects.delete("books/one/photo.jox");
    await expect(setup.library.download(request)).rejects.toThrow("404");
    expect((await setup.library.list())[0]?.status).toBe("failed");
    expect(await setup.library.open("books", "one")).toBeUndefined();
    setup.objects.set("books/one/photo.jox", new Uint8Array(photo.length));
    await expect(setup.library.download(request)).rejects.toThrow("校验失败");
    setup.objects.set("books/one/photo.jox", photo);
    await setup.library.download(request);
    expect((await setup.library.list())[0]?.status).toBe("ready");
    expect(setup.resources.size).toBe(8);
  });

  it("recovers an abandoned download as retryable, and removes both its manifest and bytes", async () => {
    const setup = fixture();
    await setup.library.download(request);
    const book = (await setup.library.list())[0]!;
    await setup.options.repository.put({ ...book, status: "downloading" });
    await new OfflineBookLibrary(setup.options).recover();
    expect((await setup.library.list())[0]).toMatchObject({ status: "failed", error: "上次下载未完成，请重试" });
    await setup.library.remove(book);
    expect(await setup.library.list()).toEqual([]);
    expect(setup.resources.size).toBe(0);
  });

  it("isolates authenticated packages and blocks a previously opened client immediately on account change", async () => {
    const setup = fixture(true);
    await setup.library.download(request);
    const opened = (await setup.library.open("books", "one"))!;
    expect(opened.scope).toBe("user:reader-a");
    setup.setIdentity({ initialized: true, userId: "reader-b" });
    expect(await setup.library.list()).toEqual([]);
    expect(await setup.library.open("books", "one")).toBeUndefined();
    await expect(opened.client.fetchJson("books/one/chapter-1.jox")).rejects.toThrow("账号登录");
    await setup.library.identityChanged();
    expect(setup.records.size).toBe(0);
    expect(setup.resources.size).toBe(0);
  });

  it("keeps public downloads after sign-out but refuses unauthenticated private downloads", async () => {
    const publicSetup = fixture();
    await publicSetup.library.download(request);
    publicSetup.setIdentity({ initialized: true, userId: "another-reader" });
    await publicSetup.library.identityChanged();
    expect((await publicSetup.library.list())[0]?.status).toBe("ready");
    const privateSetup = fixture(true);
    privateSetup.setIdentity({ initialized: true, userId: null });
    await expect(privateSetup.library.download(request)).rejects.toThrow("请先登录");
    expect(privateSetup.resources.size).toBe(0);
  });

  it("retains a completed private package when token refresh fails but its local session still belongs to the owner", async () => {
    const setup = fixture(true);
    await setup.library.download(request);
    let serialized: string | null = JSON.stringify({ expires_at: 1, user: { id: "reader-a" } });
    setup.options.identity = () => offlineIdentityFromStoredSession({ initialized: true, userId: null }, serialized, true);
    await setup.library.identityChanged();
    const local = await setup.library.open("books", "one");
    await expect(local!.client.fetchJson("books/one/chapter-2.jox")).resolves.toMatchObject({ fragmentId: "chapter:2" });
    serialized = null;
    await setup.library.identityChanged();
    expect(setup.records.size).toBe(0);
  });

  it("coordinates recovery and deletion with another active downloader instead of resurrecting a partial ready package", async () => {
    const setup = fixture();
    let tail: Promise<void> | undefined;
    const lock = async (_datasetId: string, task: () => Promise<void>, ifAvailable = false) => {
      if (ifAvailable && tail) return;
      const pending = (tail ?? Promise.resolve()).catch(() => undefined).then(task);
      tail = pending;
      try { await pending; } finally { if (tail === pending) tail = undefined; }
    };
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const putResource = setup.options.repository.putResource;
    setup.options.repository.putResource = async (book, object, bytes) => {
      if (object.endsWith("chapter-2.jox")) { reached(); await held; }
      await putResource(book, object, bytes);
    };
    const first = new OfflineBookLibrary({ ...setup.options, lock });
    const second = new OfflineBookLibrary({ ...setup.options, lock });
    const download = first.download(request);
    await waiting;
    await second.recover();
    const book = (await second.list())[0]!;
    expect(book.status).toBe("downloading");
    const deletion = second.remove(book);
    release();
    await Promise.all([download, deletion]);
    expect(await second.list()).toEqual([]);
    expect(setup.resources.size).toBe(0);
  });

  it("never uses a remembered offline owner as authorization to download a private book", async () => {
    const setup = fixture(true);
    const library = new OfflineBookLibrary({ ...setup.options, downloadIdentity: () => ({ initialized: true, userId: null }) });
    await expect(library.download(request)).rejects.toThrow("请先登录");
    expect(setup.resources.size).toBe(0);
  });

  it("cancels a download started with a cloud bookshelf item ID rather than its item key", async () => {
    const setup = fixture();
    const originalFetch = setup.options.fetch;
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    setup.options.fetch = vi.fn(async (input, init) => {
      if (String(input).includes("chapter-1.jox")) {
        reached();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
        });
      }
      return originalFetch(input, init);
    });
    const library = new OfflineBookLibrary(setup.options);
    const download = library.download({ datasetId: "books", itemKey: "book:one" });
    const outcome = download.catch((error: unknown) => error);
    await waiting;
    await library.remove((await library.list())[0]!);
    expect(await outcome).toBeInstanceOf(Error);
    expect(await library.list()).toEqual([]);
    expect(setup.resources.size).toBe(0);
  });

  it("refuses a new browser download when safe cross-tab coordination is unavailable", async () => {
    const setup = fixture();
    const library = new OfflineBookLibrary({ ...setup.options, canDownload: () => false });
    await expect(library.download(request)).rejects.toThrow("不支持可靠的离线保存");
    expect(setup.fetcher).not.toHaveBeenCalled();
  });

  it("does not advertise a book with remote inline media as complete", async () => {
    const setup = fixture();
    const chapter = setup.json("books/one/chapter-1.jox", { formatVersion: "jojo-fragment/1", itemId: "book:one", fragmentId: "chapter:1", type: "chapter", order: 1, title: "一", body: { format: "html", value: '<img src="https://external.test/image.jpg">' }, assetRefs: [], annotations: [] });
    Object.assign(setup.manifest.content.chapters[0]!, chapter);
    setup.json("books/one/manifest.jox", setup.manifest);
    await expect(setup.library.download(request)).rejects.toThrow("远程图片");
    expect((await setup.library.list())[0]?.status).toBe("failed");
  });
});
