import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TIMES_SOURCE_LOGOS, timesSourceLogoPath } from "@jojo/content";
import { describe, expect, it } from "vitest";
import { sourceLogoUrl } from "../src/times/components/SourceLogo";

describe("publisher logo parity", () => {
  it("bundles the same real PNG/JPEG assets on Web, Desktop and native", () => {
    const native = readFileSync(resolve(process.cwd(), "../mobile/src/lib/sourceLogos.ts"), "utf8");
    const mapping = Object.fromEntries([...native.matchAll(/^\s*(?:"([^"]+)"|(\w+)):\s*require\("\.\.\/\.\.\/\.\.\/web\/public\/times\/source-logos\/([^"]+)"\)/gm)]
      .map((match) => [match[1] || match[2], match[3]]));
    expect(mapping).toEqual(TIMES_SOURCE_LOGOS);
    for (const [id, filename] of Object.entries(TIMES_SOURCE_LOGOS)) {
      const bytes = readFileSync(resolve(process.cwd(), `public/times/source-logos/${filename}`));
      expect(bytes.subarray(0, filename.endsWith(".png") ? 8 : 3).toString("hex")).toBe(
        filename.endsWith(".png") ? "89504e470d0a1a0a" : "ffd8ff",
      );
      expect(sourceLogoUrl({ id, name: id, language: "en" })).toBe(`/times/source-logos/${filename}`);
      // Electron loads index.html from disk, where a leading slash targets C:/.
      expect(timesSourceLogoPath(id, "./")).toBe(`./times/source-logos/${filename}`);
    }
    expect(timesSourceLogoPath("unknown")).toBeUndefined();
  });
});
