import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Times HTTP dispatcher", () => {
  it("keeps Cheerio from installing its unfixed Undici 7 dispatcher", () => {
    const output = execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      [
        "import { load } from 'cheerio';",
        "import { createRequire } from 'node:module';",
        "import { Agent, getGlobalDispatcher } from 'undici';",
        "load('<p>Times</p>');",
        "const dispatcher = getGlobalDispatcher();",
        "const version = createRequire(import.meta.url)('undici/package.json').version;",
        "console.log(JSON.stringify({ directAgent: dispatcher instanceof Agent, version }));",
        "await dispatcher.close();",
      ].join("\n"),
    ], { cwd: packageRoot, encoding: "utf8" });

    expect(JSON.parse(output)).toEqual({ directAgent: true, version: "8.10.0" });
  });
});
