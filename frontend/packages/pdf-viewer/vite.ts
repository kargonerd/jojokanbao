import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const pdfViewerRequire = createRequire(import.meta.url);
const pdfjsRoot = dirname(pdfViewerRequire.resolve("pdfjs-dist/package.json"));

function pdfjsAsset(folder: string): string {
  return `${resolve(pdfjsRoot, folder).replaceAll("\\", "/")}/*`;
}

/** Static PDF.js resources required by every host that renders @jojo/pdf-viewer. */
export const pdfViewerStaticCopyTargets = [
  { src: pdfjsAsset("cmaps"), dest: "assets/pdfjs/cmaps" },
  { src: pdfjsAsset("wasm"), dest: "assets/pdfjs/wasm" },
  { src: pdfjsAsset("standard_fonts"), dest: "assets/pdfjs/standard_fonts" },
] as const;
