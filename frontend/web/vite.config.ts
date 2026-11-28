import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { pdfViewerStaticCopyTargets } from "@jojo/pdf-viewer/vite";
import { resolveViteEnvironmentDirectory } from "../tooling/vite-worktree-env";
import { createSearchProxy } from "../tooling/search-proxy";
import { createSpeechProxy } from "../tooling/speech-proxy";

const repositoryRoot = resolve(__dirname, "../..");
const defaultDevelopmentAgentUrl = "http://127.0.0.1:8789/rag";

export default defineConfig(({ mode }) => {
  const envDir = resolveViteEnvironmentDirectory(repositoryRoot, mode);
  const environment = loadEnv(mode, envDir, "");
  const agentTarget = new URL(
    environment.JOJO_AGENT_URL || defaultDevelopmentAgentUrl,
  );
  const agentPath = agentTarget.pathname.replace(/\/$/, "");
  return {
    envDir,
    build: { target: "chrome80" },
    plugins: [
      react(),
      tailwindcss(),
      // 部分 Android WebView 停在 Chromium 80~84（X 浏览器等外壳用的就是系统 WebView），
      // 缺 ES2021 的 replaceAll、ES2022 的 Array.prototype.at。只为这些"支持 ESM 但缺 API"的
      // 内核补 core-js 垫片，不生成 legacy 构建产物；新增较新 API 时把 core-js 模块名加进列表。
      legacy({
        targets: ["chrome >= 80"],
        modernTargets: ["chrome >= 80"],
        modernPolyfills: ["es.string.replace-all", "es.array.at"],
        renderLegacyChunks: false,
      }),
      viteStaticCopy({
        targets: [...pdfViewerStaticCopyTargets],
      }),
    ],
    resolve: { alias: { "@": resolve(__dirname, "src") } },
    server: {
      port: 8080,
      proxy: {
        ...createSearchProxy(),
        ...createSpeechProxy(environment.JOJO_SPEECH_API_BASE || undefined),
        "/api": {
          target: "http://127.0.0.1:8088",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
        "/content-cdn": {
          target: "http://127.0.0.1:8765",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/content-cdn/, ""),
        },
        // The unified entry point (`/ask`, `/ask/times`) normally lives on the
        // international Agent origin, which a dev build would have to reach over
        // the public Internet. Point `VITE_AGENT_API_BASE` at this dev server
        // and this proxy forwards `/ask` to a locally running Agent instead,
        // rewriting it to the internal `/rag` (or `/times`) route.
        "/ask": {
          target: agentTarget.origin,
          changeOrigin: true,
          headers: { Origin: "" },
          rewrite: (path) => {
            if (/^\/ask\/times(?=\?|$)/.test(path)) {
              return path.replace(/^\/ask\/times(?=\?|$)/, "/times");
            }
            return path.replace(/^\/ask(?=\?|$)/, agentPath);
          },
        },
      },
    },
  };
});
