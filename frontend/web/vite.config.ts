import { defineConfig, normalizePath } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { viteStaticCopy } from "vite-plugin-static-copy";

const pdfViewerRequire = createRequire(resolve(__dirname, "../packages/pdf-viewer/package.json"));
const pdfjsRoot = dirname(pdfViewerRequire.resolve("pdfjs-dist/package.json"));
const pdfjsAsset = (folder: string) => `${normalizePath(resolve(pdfjsRoot, folder))}/*`;

export default defineConfig({
  envDir: resolve(__dirname, "../.."),
  plugins: [
    react(),
    tailwindcss(),
    viteStaticCopy({
      targets: [
        { src: pdfjsAsset("cmaps"), dest: "assets/pdfjs/cmaps" },
        { src: pdfjsAsset("wasm"), dest: "assets/pdfjs/wasm" },
        { src: pdfjsAsset("standard_fonts"), dest: "assets/pdfjs/standard_fonts" },
      ],
    }),
  ],
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  server: { port: 8080 },
});
