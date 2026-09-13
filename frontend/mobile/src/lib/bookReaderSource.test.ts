import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { createContext, runInContext, Script } from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";
import * as content from "@jojo/content";
import { SPEECH_READER_FACTORY } from "@jojo/content/speech-dom-script";
import { CONTINUOUS_BOOK_SCROLL_FACTORY } from "./continuousBookScroll.generated";

it("ships current continuous reading code as source instead of serializing a native runtime function", () => {
  expect(() => execFileSync(process.execPath, [fileURLToPath(new URL("../../scripts/generate-book-scroll.mjs", import.meta.url)), "--check"])).not.toThrow();
}, 30_000);

it("preserves the complete executable factory through the production Hermes bytecode compiler", () => {
  const require = createRequire(import.meta.url);
  const compilerRoot = dirname(require.resolve("hermes-compiler/package.json"));
  const platform = process.platform === "win32" ? "win64-bin/hermesc.exe"
    : process.platform === "darwin" ? "osx-bin/hermesc" : "linux64-bin/hermesc";
  const artifact = join(tmpdir(), `jojo-book-scroll-${randomUUID()}.hbc`);
  const source = `const factory = ${JSON.stringify(CONTINUOUS_BOOK_SCROLL_FACTORY)}; print(factory);`;
  try {
    execFileSync(join(compilerRoot, "hermesc", platform), ["-O", "-emit-binary", "-out", artifact, "-"], { input: source });
    const bytecode = readFileSync(artifact);
    const sourceBytes = Buffer.from(CONTINUOUS_BOOK_SCROLL_FACTORY, "utf16le");
    const offset = bytecode.indexOf(sourceBytes);
    expect(offset).toBeGreaterThanOrEqual(0);
    const shippedFactory = bytecode.subarray(offset, offset + sourceBytes.length).toString("utf16le");
    expect(shippedFactory).toBe(CONTINUOUS_BOOK_SCROLL_FACTORY);
    expect(() => new Script(`const createScroll = ${shippedFactory};`)).not.toThrow();
  } finally {
    if (existsSync(artifact)) unlinkSync(artifact);
  }
}, 30_000);

it("builds a complete standalone bridge even when Hermes cannot serialize function source", () => {
  const context = createContext({});
  // Hermes AOT reports native/bytecode placeholders instead of the original JS.
  runInContext('Function.prototype.toString = function () { return "function () { [native code] }"; };', context);
  const load = (path: string) => {
    context.exports = {};
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    runInContext(code, context);
    return context.exports;
  };
  const continuous = load("./continuousBookScroll.generated.ts");
  context.require = (id: string) => {
    if (id === "@jojo/content") return content;
    if (id === "@jojo/content/speech-dom-script") return { SPEECH_READER_FACTORY };
    if (id === "./continuousBookScroll.generated") return continuous;
    throw new Error(`Unexpected bridge runtime dependency: ${id}`);
  };
  const bridge = load("./bookReaderBridge.ts") as typeof import("./bookReaderBridge");
  const script = bridge.createBookReaderBridgeScript("start", false, [], undefined, undefined, undefined, {
    initialChapterId: "chapter-6", chapters: [{ id: "chapter-6" }],
  });
  expect(() => new Script(script)).not.toThrow();
  expect(script).toContain("reader-ready");
  expect(script).toContain("reader-speech-position");
  expect(script).not.toContain("[native code]");
  expect(script).not.toContain("[bytecode]");
});
