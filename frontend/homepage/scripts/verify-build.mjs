import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const distDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
const requiredFiles = [
  "index.html",
  "about/index.html",
  "articles/index.html",
  "rss.xml",
  "sitemap-index.xml",
];

await Promise.all(requiredFiles.map((file) => access(path.join(distDirectory, file))));

const articleDirectory = path.join(distDirectory, "articles");
const articleEntries = await readdir(articleDirectory, { withFileTypes: true });
const articlePages = articleEntries.filter((entry) => entry.isDirectory());

if (articlePages.length === 0) {
  throw new Error("Homepage build does not contain any generated article pages");
}

await Promise.all(
  articlePages.map((entry) => access(path.join(articleDirectory, entry.name, "index.html"))),
);

const homepage = await readFile(path.join(distDirectory, "index.html"), "utf8");
const articleIndex = await readFile(path.join(articleDirectory, "index.html"), "utf8");
const rss = await readFile(path.join(distDirectory, "rss.xml"), "utf8");

if (!homepage.includes('href="/articles/"') || !articleIndex.includes("<h1>文章目录</h1>")) {
  throw new Error("Homepage navigation was not generated correctly");
}

if (!rss.includes("<item>")) {
  throw new Error("RSS feed does not contain any articles");
}

console.log(`Homepage build verified: ${articlePages.length} article page(s)`);
