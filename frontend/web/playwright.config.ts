import { defineConfig } from "@playwright/test";

const ci = Boolean(process.env.CI);
const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT || 8080);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  workers: ci ? 2 : undefined,
  webServer: {
    // CI must exercise the deployed artifact, including post-build CSS layer
    // flattening. Local runs keep the faster Vite development server.
    command: ci
      ? `pnpm build && pnpm preview --host 0.0.0.0 --port ${webPort}`
      : `pnpm dev --host 0.0.0.0 --port ${webPort}`,
    port: webPort,
    reuseExistingServer: !ci,
    timeout: 240_000,
    env: {
      VITE_ENABLE_PLATFORM_REDESIGN: "true",
      ...(ci ? {
        // Load the account UI without depending on repository variables or a
        // real auth backend. Reading an empty browser session is local-only.
        VITE_SUPABASE_URL: `http://127.0.0.1:${webPort}`,
        VITE_SUPABASE_PUBLISHABLE_KEY: "playwright-test-key",
      } : {}),
    },
  },
  use: {
    baseURL: `http://localhost:${webPort}`,
  },
});
