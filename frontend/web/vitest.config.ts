import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  define: {
    "import.meta.env.VITE_ENABLE_PLATFORM_REDESIGN": JSON.stringify("true"),
    "import.meta.env.VITE_ENABLE_ACCOUNT": JSON.stringify("false"),
    "import.meta.env.VITE_ENABLE_TIMES": JSON.stringify("false"),
    "import.meta.env.VITE_ENABLE_RAG": JSON.stringify("false"),
  },
  plugins: [react()],
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  test: { environment: "jsdom", include: ["tests/**/*.test.{ts,tsx}"], testTimeout: 30000 },
});
