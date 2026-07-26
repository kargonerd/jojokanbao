import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  build: { outDir: "dist", emptyOutDir: true },
  test: { environment: "jsdom", globals: true },
  server: {
    port: 4174,
    proxy: {
      "/api": "http://127.0.0.1:5000",
    },
  },
});
