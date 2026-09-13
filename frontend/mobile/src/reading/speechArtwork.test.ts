import { beforeEach, describe, expect, it, vi } from "vitest";
import { materializeSpeechArtwork } from "./speechArtwork";

const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(), writes: vi.fn(), failWrite: false,
  hash: vi.fn(async (_algorithm: string, _scope: string) => "scopehash"),
  copy: vi.fn(async (_paths: { from: string; to: string }): Promise<void> => undefined),
}));
vi.mock("expo-crypto", () => ({ CryptoDigestAlgorithm: { SHA256: "sha256" }, digestStringAsync: mocks.hash }));
vi.mock("expo-file-system", () => {
  class Directory {
    uri: string;
    constructor(base: string, name: string) { this.uri = `${base}/${name}`; }
    create() {}
  }
  class File {
    uri: string;
    constructor(base: Directory | string, name?: string) { this.uri = name ? `${typeof base === "string" ? base : base.uri}/${name}` : String(base); }
    get exists() { return mocks.files.has(this.uri); }
    get size() { return mocks.files.get(this.uri)?.length ?? 0; }
    write(data: string, options: object) {
      mocks.files.set(this.uri, data); mocks.writes(data, options);
      if (mocks.failWrite) throw new Error("no disk space");
    }
    delete() { mocks.files.delete(this.uri); }
  }
  return { File, Directory, Paths: { cache: "file:///cache" } };
});
vi.mock("expo-file-system/legacy", () => ({ copyAsync: mocks.copy }));

beforeEach(() => {
  vi.clearAllMocks(); mocks.files.clear(); mocks.failWrite = false;
  mocks.hash.mockResolvedValue("scopehash");
  mocks.copy.mockImplementation(async ({ to }) => { mocks.files.set(to, "bundled-image"); });
});

describe("lock-screen artwork sources", () => {
  it("materializes a decoded book cover as an image file and removes only its own cache file", async () => {
    mocks.files.set("file:///books/original.jpg", "original");
    const artwork = await materializeSpeechArtwork("data:image/jpeg;base64,YWJj", "reader:book");
    expect(artwork?.uri).toMatch(/^file:\/\/\/cache\/jojo-speech-artwork-v1\/scopehash-\d+-\d+\.jpg$/);
    expect(mocks.writes).toHaveBeenCalledWith("YWJj", { encoding: "base64" });
    expect(mocks.hash).toHaveBeenCalledWith("sha256", "reader:book");
    artwork!.release(); artwork!.release();
    expect([...mocks.files.keys()]).toEqual(["file:///books/original.jpg"]);
  });

  it("keeps separate cache ownership for overlapping sessions of the same cover", async () => {
    const first = await materializeSpeechArtwork("data:image/png;base64,YWJj", "reader:book");
    const second = await materializeSpeechArtwork("data:image/png;base64,YWJj", "reader:book");
    expect(first?.uri).not.toBe(second?.uri);
    first!.release();
    expect(mocks.files.has(second!.uri)).toBe(true);
    second!.release();
  });

  it.each(["https://example.test/cover.png", "http://127.0.0.1/cover.png"])("preserves an existing network image URL %s", async (uri) => {
    const artwork = await materializeSpeechArtwork(uri, "reader:news");
    expect(artwork?.uri).toBe(uri); artwork!.release();
    expect(mocks.hash).not.toHaveBeenCalled(); expect(mocks.writes).not.toHaveBeenCalled();
  });

  it("uses a readable local image without deleting its source and rejects missing or empty files", async () => {
    mocks.files.set("file:///books/cover.png", "image"); mocks.files.set("file:///books/empty.png", "");
    const artwork = await materializeSpeechArtwork("file:///books/cover.png", "reader:book");
    expect(artwork?.uri).toBe("file:///books/cover.png"); artwork!.release();
    expect(mocks.files.has("file:///books/cover.png")).toBe(true);
    expect(await materializeSpeechArtwork("file:///books/missing.png", "reader:book")).toBeUndefined();
    expect(await materializeSpeechArtwork("file:///books/empty.png", "reader:book")).toBeUndefined();
  });

  it.each([undefined, "data:image/png;base64,%%%", "data:image/png;base64,A=", "data:text/html;base64,YWJj", "content://images/1", "blob:cover"])("ignores invalid or unsupported image source %s", async (uri) => {
    expect(await materializeSpeechArtwork(uri, "reader:book")).toBeUndefined();
    expect(mocks.writes).not.toHaveBeenCalled();
  });

  it("rejects oversized covers without creating a cache file", async () => {
    expect(await materializeSpeechArtwork(`data:image/png;base64,${"A".repeat(14 * 1024 * 1024 + 4)}`, "reader:book")).toBeUndefined();
    expect(mocks.files.size).toBe(0);
  });

  it("cleans partially written files after a storage failure", async () => {
    mocks.failWrite = true;
    expect(await materializeSpeechArtwork("data:image/png;base64,YWJj", "reader:book")).toBeUndefined();
    expect(mocks.files.size).toBe(0);
  });

  it("copies a bundled publisher logo through the existing filesystem asset adapter", async () => {
    const artwork = await materializeSpeechArtwork("publisher_reuters", "reader:news");
    expect(mocks.copy).toHaveBeenCalledWith({ from: "publisher_reuters", to: artwork!.uri });
    expect(mocks.files.get(artwork!.uri)).toBe("bundled-image");
    artwork!.release(); expect(mocks.files.size).toBe(0);
  });

  it("releases an image that finishes materializing after its screen has closed", async () => {
    let finish!: () => void;
    mocks.copy.mockImplementation(({ to }) => new Promise<void>((resolve) => { finish = () => { mocks.files.set(to, "image"); resolve(); }; }));
    const controller = new AbortController();
    const result = materializeSpeechArtwork("publisher_reuters", "reader:news", controller.signal);
    await vi.waitFor(() => expect(mocks.copy).toHaveBeenCalled());
    controller.abort(); finish();
    expect(await result).toBeUndefined(); expect(mocks.files.size).toBe(0);
  });
});
