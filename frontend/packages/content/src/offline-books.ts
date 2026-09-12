import { gunzipSync, strFromU8 } from "fflate";
import { bookFragmentAssetRefs } from "./book-assets";
import { JoxClient, resolveJoxObject, transformJoxBytes } from "./jox";
import { asJojoBookSearchIndex, asJojoCatalog, asJojoDatasetIndex, asJojoFragment, asJojoItemManifest } from "./validation";
import type { JojoCatalog, JojoCatalogEntry, JojoDatasetIndex, JojoDatasetItemSummary, JojoItemManifest, JojoObjectDescriptor } from "./types";

export interface OfflineBookSnapshot {
  catalog: JojoCatalog;
  entry: JojoCatalogEntry;
  index: JojoDatasetIndex & { items: JojoDatasetItemSummary[] };
  item: JojoDatasetItemSummary;
  manifest: JojoItemManifest;
  manifestObject: string;
}

export interface OfflineBookRecord extends OfflineBookSnapshot {
  id: string;
  generation: string;
  scope: string;
  baseUrl: string;
  status: "downloading" | "ready" | "failed";
  completed: number;
  total: number;
  bytes: number;
  updatedAt: number;
  error?: string;
}

/** Dedicated, persistent book storage. Implementations must not evict like an HTTP cache. */
export interface OfflineBookRepository {
  list(): Promise<OfflineBookRecord[]>;
  put(record: OfflineBookRecord): Promise<void>;
  getResource(book: OfflineBookRecord, object: string): Promise<Uint8Array | undefined>;
  putResource(book: OfflineBookRecord, object: string, bytes: Uint8Array): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface OfflineBookRequest { datasetId: string; itemKey: string; title?: string }
export interface OfflineBookIdentity { initialized: boolean; userId: string | null }
export interface OfflineBookOptions {
  repository: OfflineBookRepository;
  baseUrl: string;
  identity: () => OfflineBookIdentity;
  /** Download authorization must use the live account, never a local offline fallback. */
  downloadIdentity?: () => OfflineBookIdentity;
  digest: (bytes: Uint8Array) => Promise<string>;
  fetch?: typeof fetch;
  /** Browser adapters lock per dataset across tabs; native apps have one JS runtime. */
  lock?: (datasetId: string, task: () => Promise<void>, ifAvailable?: boolean) => Promise<void>;
  canDownload?: () => boolean;
}

export function offlineBookAccess(book: OfflineBookSnapshot): "public" | "authenticated" {
  return book.manifest.access ?? book.item.access ?? book.index.access ?? book.entry.access ?? "public";
}

export function offlineBookVisible(book: Pick<OfflineBookRecord, "scope">, identity: OfflineBookIdentity): boolean {
  return book.scope === "public" || Boolean(identity.initialized && identity.userId && book.scope === `user:${identity.userId}`);
}

function scopeFor(book: OfflineBookSnapshot, identity: OfflineBookIdentity): string {
  if (offlineBookAccess(book) === "public") return "public";
  if (!identity.initialized || !identity.userId) throw new Error("请先登录，再保存这本书");
  return `user:${identity.userId}`;
}

function requestKey(request: OfflineBookRequest): string { return JSON.stringify([request.datasetId, request.itemKey]); }
function cancelled(): Error { return new Error("下载已暂停，可重新下载"); }

/** Shared by browser IndexedDB and native persistent-file storage. Never stores authentication data. */
export class OfflineBookLibrary {
  private readonly jobs = new Map<string, { controller: AbortController; promise: Promise<void>; scope: string | undefined }>();
  private readonly listeners = new Set<() => void>();
  private readonly client: JoxClient;
  constructor(private readonly options: OfflineBookOptions) {
    // No ResourceCache: partial downloads never become implicit offline books or public cache entries.
    this.client = new JoxClient(options.baseUrl, options.fetch);
  }

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit() { for (const listener of this.listeners) listener(); }

  async list(): Promise<OfflineBookRecord[]> {
    const records = await this.options.repository.list();
    return records.filter((book) => offlineBookVisible(book, this.options.identity()))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private locked(datasetId: string, task: () => Promise<void>, ifAvailable = false): Promise<void> {
    return this.options.lock ? this.options.lock(datasetId, task, ifAvailable) : task();
  }

  async recover(): Promise<void> {
    const datasets = new Set((await this.options.repository.list()).map((book) => book.entry.datasetId));
    for (const datasetId of datasets) await this.locked(datasetId, async () => {
      // Re-read while holding the lock: another tab may have finished or deleted it.
      for (const book of await this.options.repository.list()) {
        if (book.entry.datasetId === datasetId && book.status === "downloading" && !this.jobs.has(requestKey({ datasetId, itemKey: book.item.itemKey }))) {
          await this.options.repository.put({ ...book, status: "failed", error: "上次下载未完成，请重试" });
        }
      }
    }, true);
    this.emit();
  }

  async identityChanged(): Promise<void> {
    if (!this.options.identity().initialized) return;
    const interrupted: Promise<void>[] = [];
    for (const job of this.jobs.values()) {
      if (job.scope && !offlineBookVisible({ scope: job.scope }, this.options.identity())) {
        job.controller.abort(); interrupted.push(job.promise.catch(() => undefined));
      }
    }
    await Promise.all(interrupted);
    for (const book of await this.options.repository.list()) {
      if (!offlineBookVisible(book, this.options.identity())) await this.locked(book.entry.datasetId, async () => {
        if (!offlineBookVisible(book, this.options.identity())) await this.options.repository.remove(book.id);
      });
    }
    this.emit();
  }

  async find(datasetId: string, itemKey: string): Promise<OfflineBookRecord | undefined> {
    return (await this.list()).find((book) => book.entry.datasetId === datasetId
      && (book.item.itemKey === itemKey || book.item.itemId === itemKey));
  }

  async open(datasetId: string, itemKey: string): Promise<(OfflineBookRecord & { client: JoxClient }) | undefined> {
    const book = await this.find(datasetId, itemKey);
    if (!book || book.status !== "ready") return undefined;
    const fetchLocal: typeof fetch = async (input) => {
      if (!offlineBookVisible(book, this.options.identity())) throw new Error("请使用保存这本书的账号登录");
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const base = new URL(book.baseUrl);
      if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error("离线资源地址无效");
      const object = decodeURIComponent(url.pathname.slice(base.pathname.length));
      const bytes = await this.options.repository.getResource(book, object);
      if (!offlineBookVisible(book, this.options.identity())) throw new Error("登录状态已改变，请重新打开书籍");
      if (!bytes) throw new Error("离线文件缺失，请在书架中删除下载后重试");
      return new Response(bytes.slice().buffer, { status: 200 });
    };
    return { ...book, client: new JoxClient(book.baseUrl, fetchLocal) };
  }

  download(request: OfflineBookRequest): Promise<void> {
    if (this.options.canDownload?.() === false) return Promise.reject(new Error("当前浏览器不支持可靠的离线保存，请更新浏览器或使用客户端"));
    const key = requestKey(request);
    const existing = this.jobs.get(key);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const job = { controller, promise: Promise.resolve(), scope: undefined as string | undefined };
    this.jobs.set(key, job);
    job.promise = this.locked(request.datasetId, () => this.runDownload(request, controller.signal, (scope) => { job.scope = scope; }))
      .finally(() => { this.jobs.delete(key); this.emit(); });
    return job.promise;
  }

  async remove(book: OfflineBookRecord): Promise<void> {
    const job = this.jobs.get(requestKey({ datasetId: book.entry.datasetId, itemKey: book.item.itemKey }))
      ?? this.jobs.get(requestKey({ datasetId: book.entry.datasetId, itemKey: book.item.itemId }));
    if (job) { job.controller.abort(); await job.promise.catch(() => undefined); }
    await this.locked(book.entry.datasetId, () => this.options.repository.remove(book.id));
    this.emit();
  }

  private async runDownload(request: OfflineBookRequest, signal: AbortSignal, setScope: (scope: string) => void): Promise<void> {
    let record: OfflineBookRecord | undefined;
    const metadataBytes = new Map<string, Uint8Array>();
    const storedSizes = new Map<string, number>();
    const countResource = (object: string, bytes: Uint8Array) => {
      if (!record) return;
      record.bytes += bytes.length - (storedSizes.get(object) ?? 0);
      storedSizes.set(object, bytes.length);
      record.completed += 1;
    };
    const assertActive = () => {
      if (signal.aborted) throw cancelled();
      if (record && !offlineBookVisible(record, this.options.downloadIdentity?.() ?? this.options.identity())) throw new Error("登录状态已改变，下载已停止");
    };
    const fetchJson = async (object: string, descriptor?: JojoObjectDescriptor) => {
      assertActive();
      const bytes = await this.client.fetchBytes(object, signal, "no-store", descriptor?.sha256, 120_000);
      const decoded = gunzipSync(transformJoxBytes(bytes, object));
      if (descriptor) await this.verify(decoded, descriptor);
      assertActive();
      const value: unknown = JSON.parse(strFromU8(decoded));
      if (record) {
        await this.options.repository.putResource(record, object, bytes);
        countResource(object, bytes);
      } else metadataBytes.set(object, bytes);
      return value;
    };
    const saveProgress = async () => {
      assertActive();
      if (record) { record.updatedAt = Date.now(); await this.options.repository.put({ ...record }); this.emit(); }
    };
    try {
      const catalog = asJojoCatalog(await fetchJson("catalog.jox"));
      const entry = catalog.datasets.find((entry) => entry.datasetId === request.datasetId);
      if (!entry || !["book", "book-series"].includes(entry.type) || entry.publicationStatus === "draft") throw new Error("目前只能保存已发布的书籍");
      const index = asJojoDatasetIndex(await fetchJson(entry.indexObject));
      const item = index.items.find((item) => item.itemKey === request.itemKey || item.itemId === request.itemKey);
      if (index.datasetId !== entry.datasetId || !item || !["book", "book-volume"].includes(item.type) || item.publicationStatus === "draft" || index.publicationStatus === "draft") throw new Error("书籍目录不完整，暂时无法下载");
      const manifestObject = resolveJoxObject(entry.indexObject, item.manifestObject);
      const manifest = asJojoItemManifest(await fetchJson(manifestObject));
      if (manifest.datasetId !== entry.datasetId || manifest.itemId !== item.itemId || manifest.content.schema !== "jojo-content/book/1" || !manifest.content.chapters?.length || manifest.publicationStatus === "draft") throw new Error("书籍内容不完整，暂时无法下载");
      const snapshot = { catalog, entry, index, item, manifest, manifestObject };
      const scope = scopeFor(snapshot, this.options.downloadIdentity?.() ?? this.options.identity());
      setScope(scope);
      const id = JSON.stringify([scope, entry.datasetId, item.itemKey]);
      record = {
        ...snapshot, id, scope, baseUrl: this.client.baseUrl.href,
        generation: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        status: "downloading", completed: 0, total: 3 + manifest.content.chapters.length + (manifest.search ? 1 : 0), bytes: 0, updatedAt: Date.now(),
      };
      // A retry replaces partial files, while a completed package is left intact.
      const previous = await this.find(entry.datasetId, item.itemKey);
      if (previous?.status === "ready") return;
      if (previous) await this.options.repository.remove(previous.id);
      await saveProgress();
      for (const [object, bytes] of metadataBytes) {
        assertActive();
        await this.options.repository.putResource(record, object, bytes);
        countResource(object, bytes);
      }
      const assetIds = new Set(manifest.assets.filter((asset) => asset.role === "cover").map((asset) => asset.id));
      for (const chapter of manifest.content.chapters) {
        const fragment = asJojoFragment(await fetchJson(resolveJoxObject(manifestObject, chapter.object), chapter));
        if (fragment.fragmentId !== chapter.id || fragment.itemId !== manifest.itemId) throw new Error("章节内容与目录不匹配，请稍后重试");
        for (const id of bookFragmentAssetRefs(fragment)) assetIds.add(id);
        // Remote inline media is not represented by the publisher's asset manifest.
        if (fragment.body.format === "html") {
          for (const media of fragment.body.value.matchAll(/<(?:img|audio|video|source)\b[^>]*>/gi)) {
            for (const attribute of media[0].matchAll(/\b(?:src|srcset|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
              if (!/^data:/i.test((attribute[1] ?? attribute[2] ?? attribute[3] ?? "").trim())) throw new Error("书中包含尚未打包的远程图片或媒体，暂不能完整离线保存");
            }
          }
        }
        await saveProgress();
      }
      const assets = new Map(manifest.assets.map((asset) => [asset.id, asset]));
      // Posters may themselves be referenced only by another media asset.
      for (const id of assetIds) {
        const asset = assets.get(id);
        if (!asset) throw new Error(`书籍资源缺失：${id}`);
        if (asset.posterAssetId) assetIds.add(asset.posterAssetId);
      }
      record.total += assetIds.size;
      await saveProgress();
      for (const id of assetIds) {
        const asset = assets.get(id)!;
        const object = resolveJoxObject(manifestObject, asset.object);
        const bytes = await this.client.fetchBytes(object, signal, "no-store", asset.sha256, 120_000);
        await this.verify(transformJoxBytes(bytes, object), asset);
        assertActive();
        await this.options.repository.putResource(record, object, bytes);
        countResource(object, bytes);
        await saveProgress();
      }
      if (manifest.search) {
        const search = asJojoBookSearchIndex(await fetchJson(resolveJoxObject(manifestObject, manifest.search.object), manifest.search));
        if (search.itemId !== manifest.itemId) throw new Error("书内搜索文件与书籍不匹配");
      }
      assertActive();
      if (record.completed !== record.total) throw new Error("离线文件未全部保存，请重试");
      record.status = "ready";
      await saveProgress();
    } catch (reason) {
      if (record) {
        const error = reason instanceof Error && reason.name === "QuotaExceededError" ? "设备空间不足，请删除部分离线书籍后重试" : reason instanceof Error ? reason.message : "下载失败，请重试";
        await this.options.repository.put({ ...record, status: "failed", error, updatedAt: Date.now() }).catch(() => undefined);
        this.emit();
      }
      throw reason;
    }
  }

  private async verify(bytes: Uint8Array, descriptor: JojoObjectDescriptor): Promise<void> {
    if (bytes.length !== descriptor.size || !/^[a-f\d]{64}$/i.test(descriptor.sha256) || (await this.options.digest(bytes)).toLowerCase() !== descriptor.sha256.toLowerCase()) {
      throw new Error("下载文件校验失败，请重试");
    }
  }
}

export function formatOfflineBookBytes(bytes: number): string {
  if (!bytes) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
