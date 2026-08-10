import { describe, expect, it } from "vitest";
import {
  JoxClient,
  gunzipJoxJson,
  resolveJoxObject,
  transformJoxBytes,
} from "../src";

describe("Jox transport", () => {
  it("round-trips arbitrary bytes and supports offsets", () => {
    const original = Uint8Array.from({ length: 1024 }, (_, index) => index % 251);
    const encoded = transformJoxBytes(original, "content/books/assets/example.jox");
    expect(encoded).not.toEqual(original);
    expect(transformJoxBytes(encoded, "content/books/assets/example.jox"))
      .toEqual(original);
    expect(transformJoxBytes(encoded.slice(117, 488), "content/books/assets/example.jox", 117))
      .toEqual(original.slice(117, 488));
  });

  it("decodes gzip JSON and fetches objects relative to the configured root", async () => {
    const payload = { formatVersion: "jojo-catalog/1", revision: 1 };
    const compressed = new Uint8Array(await new Response(
      new Blob([JSON.stringify(payload)]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer());
    const key = "catalog.jox";
    const protectedBytes = transformJoxBytes(compressed, key);
    await expect(gunzipJoxJson(protectedBytes, key)).resolves.toEqual(payload);

    const fetchFn = async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://cdn.example/root/catalog.jox");
      return new Response(protectedBytes.slice().buffer);
    };
    const client = new JoxClient("https://cdn.example/root", fetchFn as typeof fetch);
    await expect(client.fetchJson(key)).resolves.toEqual(payload);
  });

  it("resolves nested object references", () => {
    expect(resolveJoxObject(
      "content/books/example/items/full-book/manifest.jox",
      "chapters/abc.jox",
    )).toBe("content/books/example/items/full-book/chapters/abc.jox");
    expect(resolveJoxObject(
      "content/newspapers/rmrb/availability/1990.jox",
      "../items/1990/01/1990-01-01/manifest.jox",
    )).toBe("content/newspapers/rmrb/items/1990/01/1990-01-01/manifest.jox");
  });
});
