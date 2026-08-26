import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { pdfViewerStaticCopyTargets } from "@jojo/pdf-viewer/vite";

const repositoryRoot = resolve(__dirname, "../..");
const defaultDevelopmentAgentUrl = "http://127.0.0.1:8789/rag";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, repositoryRoot, "");
  const agentTarget = new URL(
    environment.JOJO_AGENT_URL || defaultDevelopmentAgentUrl,
  );
  const agentPath = agentTarget.pathname.replace(/\/$/, "");
  return {
    envDir: repositoryRoot,
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
        "/gateway": {
          target: agentTarget.origin,
          changeOrigin: true,
          headers: { Origin: "" },
          rewrite: (path) => path.replace(
            /^\/gateway\/ask(?=\?|$)/,
            agentPath,
          ),
        },
      },
    },
  };
});
