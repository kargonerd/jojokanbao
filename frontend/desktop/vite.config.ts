import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { pdfViewerStaticCopyTargets } from "@jojo/pdf-viewer/vite";
import { resolveViteEnvironmentDirectory } from "../tooling/vite-worktree-env";

export default defineConfig(({ mode }) => ({
  envDir: resolveViteEnvironmentDirectory(resolve(__dirname, "../.."), mode),
  base: "./",
  publicDir: resolve(__dirname, "../web/public"),
  plugins: [
    react(),
    tailwindcss(),
    viteStaticCopy({ targets: [...pdfViewerStaticCopyTargets] }),
  ],
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  server: { port: 4173 },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
        },
      },
    },
  },
}));
