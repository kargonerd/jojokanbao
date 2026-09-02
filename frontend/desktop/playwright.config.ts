import { defineConfig } from "@playwright/test";

const desktopRendererPort = 4183;

export default defineConfig({
  testDir: "./e2e",
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${desktopRendererPort} --strictPort`,
    cwd: import.meta.dirname,
    env: {
      VITE_SUPABASE_URL: "",
      VITE_SUPABASE_PUBLISHABLE_KEY: "",
    },
    url: `http://127.0.0.1:${desktopRendererPort}`,
    reuseExistingServer: false,
  },
  use: { baseURL: `http://127.0.0.1:${desktopRendererPort}` },
});
