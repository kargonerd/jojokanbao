import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assetObjectBlob: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("../src/times/api", () => ({
  timesApi: { assetObjectBlob: mocks.assetObjectBlob },
}));
vi.mock("../src/account/auth", () => ({
  authClient: { auth: { getSession: mocks.getSession } },
}));

import { explainTimesSelection, prepareTimesAgentImages } from "../src/times/ai";

const imageAsset = {
  id: "asset:lead",
  type: "image" as const,
  role: "lead",
  mediaType: "image/png",
  object: "content/newspapers/ap/assets/lead.jox",
  size: 3,
  sha256: "lead",
  alt: "红色曲线图",
};
const news = {
  id: "article-one",
  title: "Headline",
  summary: "Summary",
  contentStatus: "full" as const,
  publishedAt: "2026-08-29T08:00:00.000Z",
  issueDate: "2026-08-29",
  language: "zh",
  source: { id: "ap", name: "AP News", language: "en" },
  url: "https://example.com/article-one",
  articleObject: "content/newspapers/ap/articles/article-one.jox",
  assets: [imageAsset],
  content: "正文提到图表中的红色曲线正在上升。",
  contentFormat: "text" as const,
  assetUrls: {},
};
const anchor = { quote: "红色曲线", prefix: "图表中的", suffix: "正在上升", startOffset: 6, endOffset: 10 };

beforeEach(() => {
  mocks.assetObjectBlob.mockResolvedValue(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: "reader-token" } }, error: null });
});
afterEach(() => vi.unstubAllGlobals());

describe("Times AI explanation", () => {
  it("prepares archived article images as base64 multimodal input", async () => {
    const prepared = await prepareTimesAgentImages(news);
    expect(prepared.images).toEqual([{ mimeType: "image/png", data: "AQID" }]);
    expect(prepared.assets).toEqual([imageAsset]);
  });

  it("sends text and images to the Times agent and streams the answer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response([
      'event: status\ndata: {"provider":"openai-codex","model":"vision"}',
      'event: text_delta\ndata: {"delta":"这是"}',
      'event: text_delta\ndata: {"delta":"解释"}',
      'event: done\ndata: {}',
      "",
    ].join("\n\n"), { headers: { "Content-Type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const chunks: string[] = [];
    let done: { imageCount: number; model?: string } | undefined;
    const completed = new Promise<void>((resolve, reject) => {
      explainTimesSelection(news, anchor, {
        onStatus: vi.fn(),
        onChunk: (text) => chunks.push(text),
        onDone: (metadata) => { done = metadata; resolve(); },
        onError: reject,
      });
    });
    await completed;

    const [target, init] = fetchMock.mock.calls[0]!;
    expect(target).toBe("/gateway/times/explain");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer reader-token");
    expect(headers.get("makers-conversation-id")).toMatch(/^times_[a-f0-9]{24}$/u);
    expect(headers.get("makers-conversation-id")?.length).toBeLessThanOrEqual(36);
    const body = JSON.parse(init.body as string);
    expect(body.message).toContain("红色曲线");
    expect(body.message).toContain("图片 1：红色曲线图");
    expect(body.images).toEqual([{ mimeType: "image/png", data: "AQID" }]);
    expect(chunks.join("")).toBe("这是解释");
    expect(done).toMatchObject({ imageCount: 1, model: "vision" });
  });

  it("reports an interrupted stream instead of accepting a partial answer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      'event: text_delta\ndata: {"delta":"不完整"}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    )));
    const chunks: string[] = [];
    const error = await new Promise<string>((resolve, reject) => {
      explainTimesSelection(news, anchor, {
        onStatus: vi.fn(),
        onChunk: (text) => chunks.push(text),
        onDone: () => reject(new Error("interrupted stream must not complete")),
        onError: resolve,
      });
    });

    expect(chunks).toEqual(["不完整"]);
    expect(error).toContain("连接意外中断");
  });
});
