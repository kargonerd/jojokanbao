import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("search box styles", () => {
  it("keeps shared input defaults low-specificity after production flattens layers", async () => {
    const sharedCss = await readFile(
      resolve(process.cwd(), "../packages/ui/styles/index.css"),
      "utf8",
    );
    const shellCss = await readFile(resolve(process.cwd(), "src/shell/styles.css"), "utf8");

    expect(sharedCss).toContain(
      ':where(input:not([type="radio"]):not([type="checkbox"]), select, textarea)',
    );
    expect(sharedCss).toContain(":where(:focus-visible)");
    expect(sharedCss).not.toMatch(/^\s*:focus-visible\s*\{/m);
    expect(sharedCss).not.toMatch(/^\s*input:not\(\[type="radio"\]\):not\(\[type="checkbox"\]\),/m);
    expect(shellCss).toMatch(/\.app-search-box input,[^{]*\{[^}]*border:\s*0;/s);
  });
});
