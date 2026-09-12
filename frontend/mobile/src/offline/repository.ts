import type { OfflineBookRecord, OfflineBookRepository } from "@jojo/content";

async function storage() {
  const { File, Directory, Paths } = await import("expo-file-system");
  const Crypto = await import("expo-crypto");
  const root = new Directory(Paths.document, "jojo-offline-books-v1");
  root.create({ idempotent: true, intermediates: true });
  return { root, File, Directory, hash: (key: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, key) };
}

export const mobileOfflineBookRepository: OfflineBookRepository = {
  async list() {
    const { root, File } = await storage();
    const records: OfflineBookRecord[] = [];
    for (const entry of root.list()) {
      if (!("list" in entry)) continue;
      const metadata = new File(entry, "book.json");
      const pending = new File(entry, "book.pending.json");
      for (const file of [metadata, pending]) {
        if (!file.exists) continue;
        try {
          const book = JSON.parse(await file.text()) as OfflineBookRecord;
          if (book.id && book.generation && book.manifest && ["ready", "downloading", "failed"].includes(book.status)) {
            records.push(file === pending ? { ...book, status: "failed", error: "上次保存未完成，请重试" } : book);
            break;
          }
        } catch { /* An interrupted metadata write must never be advertised as a complete download. */ }
      }
    }
    return records;
  },
  async put(book) {
    const { root, Directory, File, hash } = await storage();
    const directory = new Directory(root, await hash(book.id));
    directory.create({ idempotent: true, intermediates: true });
    // Write the complete new state before replacing the visible metadata.
    const pending = new File(directory, "book.pending.json");
    const metadata = new File(directory, "book.json");
    pending.write(JSON.stringify(book));
    if (metadata.exists) metadata.delete();
    pending.move(metadata);
  },
  async getResource(book, object) {
    const { root, Directory, File, hash } = await storage();
    const directory = new Directory(root, await hash(book.id));
    const file = new File(directory, await hash(`${book.generation}\0${object}`));
    return file.exists ? file.bytes() : undefined;
  },
  async putResource(book, object, bytes) {
    const { root, Directory, File, hash } = await storage();
    const directory = new Directory(root, await hash(book.id));
    directory.create({ idempotent: true, intermediates: true });
    new File(directory, await hash(`${book.generation}\0${object}`)).write(bytes);
  },
  async remove(id) {
    const { root, Directory, hash } = await storage();
    const directory = new Directory(root, await hash(id));
    if (directory.exists) directory.delete();
  },
};
