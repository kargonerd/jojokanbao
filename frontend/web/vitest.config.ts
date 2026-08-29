import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  define: {
    "import.meta.env.VITE_ENABLE_PLATFORM_REDESIGN": JSON.stringify("true"),
    "import.meta.env.VITE_ENABLE_TIMES": JSON.stringify("false"),
  },
  plugins: [react()],
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
    // Keep mocks and workspace sources on the same physical PDF.js module
    // when pnpm uses its isolated node_modules layout.
    dedupe: ["pdfjs-dist"],
  },
  test: { environment: "jsdom", include: ["tests/**/*.test.{ts,tsx}"], testTimeout: 30000 },
});
