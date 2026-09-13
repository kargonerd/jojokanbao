import { gzipSync } from "node:zlib";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transformJoxBytes, type JojoFragment, type JojoItemManifest } from "@jojo/content";
import { ContentPreviewPage } from "./ContentPreviewPage";
import { previewClient } from "../content/preview";

const base = "/api/content/jobs/local-book/preview/delivery/";
const root = "content/books/test/items/full-book/";
const manifestKey = `${root}manifest.jox`;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let requests: string[];
let objects: Map<string, Uint8Array>;
let jobStatus: string;
let manifest: JojoItemManifest;
let failImage: boolean;
const scroll = vi.fn();
const revoke = vi.fn();

function object(key: string, value: unknown) {
  objects.set(key, transformJoxBytes(new Uint8Array(gzipSync(JSON.stringify(value))), key));
}

beforeEach(() => {
  requests = []; objects = new Map(); jobStatus = "ready"; failImage = false;
  scroll.mockReset(); revoke.mockReset();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET");
    const path = new URL(String(input), location.origin).pathname;
    requests.push(path);
    if (path === "/api/content/jobs/local-book") return response({ success: true, job: {
      jobId: "local-book", status: jobStatus, report: { itemsBuilt: [
        { itemId: "test:one", itemTitle: "第一卷", manifestObject: manifestKey },
        { itemId: "test:two", itemTitle: "第二卷", manifestObject: `${root}second.jox` },
      ] },
    } });
    if (!path.startsWith(base)) throw new Error("Unexpected remote request");
    const key = path.slice(base.length);
    if (failImage && key.endsWith("photo.jox")) return response({}, 404);
    const bytes = objects.get(key);
    return bytes ? new Response(bytes.slice().buffer) : response({}, 404);
  }));
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn(() => "blob:local-photo");
    static revokeObjectURL = revoke;
  });
  Element.prototype.scrollIntoView = scroll;
  manifest = {
    formatVersion: "jojo-item-manifest/1", revision: 1, itemId: "test:one", datasetId: "test",
    type: "book", title: "第一卷", language: "zh-CN", publicationStatus: "draft", access: "authenticated",
    metadata: {}, contentStats: { characterCount: 30 }, exports: [],
    content: { schema: "jojo-content/book/1", chapters: [
      { id: "ch1", title: "第一章", order: 1, characterCount: 15, object: "one.jox", sha256: "one", size: 1 },
      { id: "ch2", title: "第二章", order: 2, characterCount: 15, object: "two.jox", sha256: "two", size: 1 },
    ], toc: [
      { id: "toc1", title: "第一章", order: 1, targetId: "ch1" },
      { id: "toc2", title: "第二章", order: 2, targetId: "ch2", children: [
        { id: "toc2a", title: "第二章小节", order: 1, targetId: "ch2", anchorId: "section-two" },
      ] },
    ] },
    assets: [{ id: "photo", type: "image", mediaType: "image/png", object: "photo.jox", sha256: "photo", size: 3 }],
  };
  object(manifestKey, manifest);
  const first: JojoFragment = {
    formatVersion: "jojo-fragment/1", itemId: "test:one", fragmentId: "ch1", type: "chapter", order: 1,
    title: "第一章", assetRefs: [],
    body: { format: "html", value: '<h1>第一章<sup data-annotation-id="title-note"></sup></h1><p>本地正文<sup data-annotation-id="note1"></sup></p><figure data-asset-id="photo"><figcaption>测试插图</figcaption></figure><a data-target-id="ch2" data-anchor-id="section-two">跨章链接</a><script>alert(1)</script><img onerror="alert(1)">' },
    annotations: [
      { id: "title-note", targetId: "ch1", kind: "footnote", label: "*", body: { format: "text", value: "标题附注" } },
      { id: "note1", targetId: "ch1", kind: "footnote", label: "1", body: { format: "text", value: "这里是注释内容" } },
    ],
  };
  object(`${root}one.jox`, first);
  object(`${root}two.jox`, { ...first, fragmentId: "ch2", title: "第二章", order: 2, assetRefs: [], annotations: [], body: { format: "html", value: '<h2 id="section-two">第二章小节</h2><p>第二章正文</p>' } });
  object(`${root}second.jox`, { ...manifest, itemId: "test:two", title: "第二卷", content: { ...manifest.content, chapters: [{ ...manifest.content.chapters![0], object: "volume-two.jox" }] } });
  object(`${root}volume-two.jox`, { ...first, itemId: "test:two", body: { format: "text", value: "第二卷正文" }, annotations: [] });
  objects.set(`${root}photo.jox`, transformJoxBytes(new Uint8Array([1, 2, 3]), `${root}photo.jox`));
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function openPreview() {
  return render(<MemoryRouter initialEntries={["/content/local-book/preview"]}><Routes>
    <Route path="/content/:jobId/preview" element={<ContentPreviewPage />} />
  </Routes></MemoryRouter>);
}

// Decoding and rendering can be delayed while CI builds other workspaces.
function findPreviewText(text: string) {
  return screen.findByText(text, {}, { timeout: 5_000 });
}

describe("local book preview", () => {
  it("decodes draft Reader objects and supports images, notes, TOC anchors and volume switching without publishing", async () => {
    const { container } = openPreview();
    await findPreviewText("本地正文");
    expect(screen.getByRole("img", { name: "测试插图" })).toHaveAttribute("src", "blob:local-photo");
    expect(container.querySelector("script, [onerror]")).toBeNull();
    expect(screen.getByRole("button", { name: "上一章" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "← 返回处理与预览" })).toHaveAttribute("href", "/content?job=local-book&step=2");
    expect(screen.getByRole("link", { name: "预览完成，设置发布" })).toHaveAttribute("href", "/content?job=local-book&step=3");

    const titleNoteLink = screen.getByRole("link", { name: "查看注释 *" });
    expect(titleNoteLink.closest("h2")).toHaveTextContent("第一章");
    expect(titleNoteLink.closest(".preview-prose")).toBeNull();
    fireEvent.click(titleNoteLink);
    await waitFor(() => expect(document.activeElement?.id).toBe("title-note"));
    fireEvent.click(within(document.getElementById("title-note")!).getByRole("link", { name: "返回正文脚注标记" }));
    await waitFor(() => expect(document.activeElement?.id).toBe("annotation-ref-title-note"));
    fireEvent.click(screen.getByRole("link", { name: "查看注释 1" }));
    await waitFor(() => expect(document.activeElement?.id).toBe("note1"));
    fireEvent.click(within(document.getElementById("note1")!).getByRole("link", { name: "返回正文脚注标记" }));
    await waitFor(() => expect(document.activeElement?.id).toBe("annotation-ref-note1"));
    fireEvent.click(screen.getByText("跨章链接"));
    await findPreviewText("第二章正文");
    await waitFor(() => expect(document.activeElement?.id).toBe("section-two"));
    expect(screen.getByRole("button", { name: "下一章" })).toBeDisabled();
    expect(revoke).toHaveBeenCalledWith("blob:local-photo");
    fireEvent.click(screen.getByRole("button", { name: "上一章" }));
    await findPreviewText("本地正文");
    fireEvent.click(within(screen.getByRole("navigation", { name: "书籍目录" })).getByRole("button", { name: "第二章小节" }));
    await findPreviewText("第二章正文");
    fireEvent.change(screen.getByLabelText("选择分卷"), { target: { value: "1" } });
    await findPreviewText("第二卷正文");
    expect(requests.every((path) => path === "/api/content/jobs/local-book" || path.startsWith(base))).toBe(true);
  }, 30_000);

  it("keeps readable text when a local image is missing and displays the failure", async () => {
    failImage = true;
    openPreview();
    await findPreviewText("本地正文");
    expect(screen.getByRole("alert")).toHaveTextContent("图片未能加载");
  });

  it("shows a recoverable error while generation is incomplete", async () => {
    jobStatus = "building";
    openPreview();
    expect(await screen.findByRole("alert")).toHaveTextContent("内容尚未生成");
    expect(requests).toEqual(["/api/content/jobs/local-book"]);
    jobStatus = "ready";
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    await findPreviewText("本地正文");
  });

  it("refuses object paths pointing outside this job instead of fetching them", async () => {
    await expect(previewClient("local-book").fetchJson("../../../../status")).rejects.toThrow("预览只能读取本次导入的本地文件");
    expect(requests).toEqual([]);
  });
});
