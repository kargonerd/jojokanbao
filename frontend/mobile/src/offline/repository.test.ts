import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OfflineBookRecord } from "@jojo/content";

const disk = vi.hoisted(() => ({ files: new Map<string, Uint8Array>(), directories: new Set<string>() }));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA256" },
  digestStringAsync: async (_algorithm: string, text: string) => createHash("sha256").update(text).digest("hex"),
}));
vi.mock("expo-file-system", () => {
  const path = (parent: string | { uri: string }, name: string) => `${typeof parent === "string" ? parent : parent.uri}/${name}`;
  class File {
    uri: string;
    constructor(parent: string | { uri: string }, name: string) { this.uri = path(parent, name); }
    get exists() { return disk.files.has(this.uri); }
    write(value: Uint8Array | string) { disk.files.set(this.uri, typeof value === "string" ? new TextEncoder().encode(value) : value.slice()); }
    async bytes() { return disk.files.get(this.uri)!.slice(); }
    async text() { return new TextDecoder().decode(await this.bytes()); }
    delete() { disk.files.delete(this.uri); }
    move(target: File) { disk.files.set(target.uri, disk.files.get(this.uri)!); disk.files.delete(this.uri); this.uri = target.uri; }
  }
  class Directory {
    uri: string;
    constructor(parent: string | { uri: string }, name: string) { this.uri = path(parent, name); }
    get exists() { return disk.directories.has(this.uri); }
    create() { disk.directories.add(this.uri); }
    list() {
      const prefix = `${this.uri}/`;
      const directories = [...disk.directories].filter((value) => value.startsWith(prefix) && !value.slice(prefix.length).includes("/"));
      const files = [...disk.files.keys()].filter((value) => value.startsWith(prefix) && !value.slice(prefix.length).includes("/"));
      return [...directories.map((value) => new Directory(this.uri, value.slice(prefix.length))), ...files.map((value) => new File(this.uri, value.slice(prefix.length)))];
    }
    delete() {
      for (const key of disk.files.keys()) if (key.startsWith(`${this.uri}/`)) disk.files.delete(key);
      for (const key of disk.directories) if (key === this.uri || key.startsWith(`${this.uri}/`)) disk.directories.delete(key);
    }
  }
  return { File, Directory, Paths: { document: "document", cache: "cache" } };
});

import { mobileOfflineBookRepository as repository } from "./repository";
const book = { id: '["public","books","one"]', generation: "download-1", status: "ready", manifest: { title: "一本书" } } as OfflineBookRecord;

beforeEach(() => { disk.files.clear(); disk.directories.clear(); });

describe("native managed offline storage", () => {
  it("persists metadata and original bytes in documents, independently of the evictable cache", async () => {
    await repository.put(book);
    await repository.putResource(book, "books/chapter.jox", new Uint8Array([0, 255, 10]));
    expect(await repository.list()).toEqual([book]);
    expect(await repository.getResource(book, "books/chapter.jox")).toEqual(new Uint8Array([0, 255, 10]));
    expect([...disk.files.keys()].every((key) => key.startsWith("document/jojo-offline-books-v1/"))).toBe(true);
    expect(await repository.getResource({ ...book, generation: "download-2" }, "books/chapter.jox")).toBeUndefined();
  });

  it("removes only the chosen book, including all its partial resources", async () => {
    const second = { ...book, id: '["public","books","two"]' };
    for (const record of [book, second]) {
      await repository.put(record);
      await repository.putResource(record, "chapter.jox", new Uint8Array([1]));
    }
    await repository.remove(book.id);
    expect(await repository.list()).toEqual([second]);
    expect(await repository.getResource(book, "chapter.jox")).toBeUndefined();
    expect(await repository.getResource(second, "chapter.jox")).toEqual(new Uint8Array([1]));
  });

  it("does not list incomplete or corrupted metadata as a ready book", async () => {
    await repository.put(book);
    const metadata = [...disk.files.keys()].find((key) => key.endsWith("/book.json"))!;
    disk.files.set(metadata, new TextEncoder().encode('{"status":"ready"'));
    disk.files.set(metadata.replace("book.json", "book.pending.json"), new TextEncoder().encode(JSON.stringify(book)));
    expect(await repository.list()).toEqual([{ ...book, status: "failed", error: "上次保存未完成，请重试" }]);
  });
});
