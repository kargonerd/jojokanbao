import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { pdfViewerStaticCopyTargets } from "@jojo/pdf-viewer/vite";

const repositoryRoot = resolve(__dirname, "../..");
const defaultAgentGateway = "https://agent-global.jojokanbao.cn/gateway/ask";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, repositoryRoot, "");
  const agentGatewayOrigin = new URL(
    environment.JOJO_AGENT_GATEWAY_URL || defaultAgentGateway,
  ).origin;
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
        "/content-cdn": {
          target: "http://127.0.0.1:8765",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/content-cdn/, ""),
        },
        "/gateway": {
          target: agentGatewayOrigin,
          changeOrigin: true,
          headers: { Origin: "" },
        },
      },
    },
  };
});
