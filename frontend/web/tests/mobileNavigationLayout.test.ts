import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesPath = resolve(process.cwd(), "src/shell/styles.css");

describe("Mobile bottom navigation layout", () => {
  it("does not depend on :has(), which Chromium 92 on HarmonyOS devices cannot parse", async () => {
    const css = (await readFile(stylesPath, "utf8")).replace(/\/\*[\s\S]*?\*\//gu, "");

    expect(css).not.toMatch(/:has\(/u);
    expect(css).toMatch(/--app-bottom-navigation-height:\s*calc\(56px \+ env\(safe-area-inset-bottom\)\)/u);
  });

  it("gives the navigation its own height so the bar still shows when the variable is missing", async () => {
    const css = await readFile(stylesPath, "utf8");
    const rule = css.match(/\.app-mobile-navigation\s*\{(?<body>[^}]*)\}/u)?.groups?.body ?? "";

    expect(rule).toMatch(/height:\s*calc\(56px \+ env\(safe-area-inset-bottom\)\)/u);
  });
});
