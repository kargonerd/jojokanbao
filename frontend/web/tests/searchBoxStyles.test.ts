import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("search box styles", () => {
  it("keeps the input reset stronger than flattened shared input styles", async () => {
    const css = await readFile(resolve(process.cwd(), "src/shell/styles.css"), "utf8");

    expect(css).toContain(
      '.app-search-box input:not([type="radio"]):not([type="checkbox"])',
    );
    expect(css).toMatch(
      /\.app-search-box input:not\(\[type="radio"\]\):not\(\[type="checkbox"\]\)[^{]*\{[^}]*border:\s*0;/s,
    );
  });
});
