import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { pdfViewerStaticCopyTargets } from "@jojo/pdf-viewer/vite";

export default defineConfig({
  envDir: resolve(__dirname, "../.."),
  plugins: [
    react(),
    tailwindcss(),
    viteStaticCopy({
      targets: [...pdfViewerStaticCopyTargets],
    }),
  ],
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  server: {
    port: 8080,
    proxy: {
      "/content-cdn": {
        target: "http://127.0.0.1:8765",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/content-cdn/, ""),
      },
    },
  },
});
