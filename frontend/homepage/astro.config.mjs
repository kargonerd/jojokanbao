import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { fileURLToPath } from "node:url";
import { resolveViteEnvironmentDirectory } from "../tooling/vite-worktree-env.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  site: "https://jojokanbao.cn",
  output: "static",
  integrations: [react(), sitemap()],
  vite: {
    envDir: resolveViteEnvironmentDirectory(repositoryRoot, process.env.NODE_ENV || "production"),
    plugins: [tailwindcss()],
  },
});
