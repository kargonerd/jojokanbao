import type { OfflineBookRecord, OfflineBookRepository } from "@jojo/content";

const DATABASE = "jojo-offline-books-v1";
let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new Error("当前环境不支持离线保存，请使用浏览器或客户端"));
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("books", { keyPath: "id" });
      db.createObjectStore("resources", { keyPath: "key" }).createIndex("bookId", "bookId");
    };
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = undefined; }; resolve(request.result); };
    request.onerror = () => { database = undefined; reject(request.error ?? new Error("无法打开离线书籍存储")); };
  });
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("离线文件保存失败"));
  });
}
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
function resourceKey(book: OfflineBookRecord, object: string): string { return JSON.stringify([book.id, book.generation, object]); }

export const browserOfflineBookRepository: OfflineBookRepository = {
  async list() {
    const db = await openDatabase();
    return result(db.transaction("books", "readonly").objectStore("books").getAll()) as Promise<OfflineBookRecord[]>;
  },
  async put(book) {
    const db = await openDatabase();
    const transaction = db.transaction("books", "readwrite");
    transaction.objectStore("books").put(book);
    await completed(transaction);
  },
  async getResource(book, object) {
    const db = await openDatabase();
    const saved = await result(db.transaction("resources", "readonly").objectStore("resources").get(resourceKey(book, object))) as { bytes: Uint8Array } | undefined;
    return saved?.bytes;
  },
  async putResource(book, object, bytes) {
    const db = await openDatabase();
    const transaction = db.transaction("resources", "readwrite");
    transaction.objectStore("resources").put({ key: resourceKey(book, object), bookId: book.id, bytes });
    await completed(transaction);
  },
  async remove(id) {
    const db = await openDatabase();
    const transaction = db.transaction(["books", "resources"], "readwrite");
    transaction.objectStore("books").delete(id);
    const resources = transaction.objectStore("resources");
    const cursor = resources.index("bookId").openKeyCursor(IDBKeyRange.only(id));
    cursor.onsuccess = () => { if (cursor.result) { resources.delete(cursor.result.primaryKey); cursor.result.continue(); } };
    await completed(transaction);
  },
};
