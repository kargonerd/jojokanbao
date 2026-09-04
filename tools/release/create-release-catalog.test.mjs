import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createReleaseCatalog } from "./create-release-catalog.mjs";

test("creates a desktop catalog from matrix artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jojo-release-"));
  try {
    const windows = path.join(root, "desktop-windows-x64");
    const mac = path.join(root, "desktop-macos-arm64");
    await mkdir(windows);
    await mkdir(mac);
    await writeFile(path.join(windows, "JOJO-Kanbao-1.2.3-x64.exe"), "windows");
    await writeFile(path.join(mac, "JOJO-Kanbao-1.2.3-arm64.dmg"), "mac");
    await writeFile(path.join(mac, "JOJO-Kanbao-1.2.3-arm64.zip"), "updater-only");
    const catalog = await createReleaseCatalog({
      product: "desktop",
      channel: "stable",
      version: "1.2.3",
      publishedAt: "2026-09-03T00:00:00.000Z",
      baseUrl: "https://blacknews.jojokanbao.cn",
      repositoryUrl: "https://github.com/kargonerd/jojokanbao",
      tag: "desktop-v1.2.3",
      input: root,
    });
    assert.equal(catalog.artifacts.length, 2);
    assert.equal(catalog.artifacts[0].sha256.length, 64);
    assert.match(catalog.artifacts[1].url, /win-x64/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("creates an e-ink mobile catalog with its build number", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jojo-release-"));
  try {
    await writeFile(path.join(root, "JOJO-Kanbao-EInk-1.2.3.apk"), "apk");
    const catalog = await createReleaseCatalog({
      product: "mobile",
      variant: "eink",
      channel: "stable",
      version: "1.2.3",
      buildNumber: "42",
      baseUrl: "https://blacknews.jojokanbao.cn/",
      repositoryUrl: "https://github.com/kargonerd/jojokanbao",
      tag: "mobile-eink-v1.2.3",
      input: root,
    });
    assert.equal(catalog.buildNumber, 42);
    assert.equal(catalog.artifacts[0].id, "android-eink");
    assert.match(catalog.artifacts[0].url, /mobile\/android-eink\/stable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects beta release catalogs", async () => {
  await assert.rejects(
    createReleaseCatalog({
      product: "desktop",
      channel: "beta",
      version: "1.2.3-beta.1",
      baseUrl: "https://blacknews.jojokanbao.cn",
      repositoryUrl: "https://github.com/kargonerd/jojokanbao",
      tag: "desktop-v1.2.3-beta.1",
      input: ".",
    }),
    /Unsupported channel: beta/,
  );
});
