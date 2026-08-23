import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RmrbReviewPage } from "./RmrbReviewPage";

const first = {
  date: "1950-01-01",
  page: 1,
  peopleDataOrdinal: 2,
  title: "第一篇",
  status: "local-content-missing",
  rawRecoveryClass: "本地两份数据均无正文",
  peopleDataHref: "https://example.test/first",
};
const second = { ...first, date: "1950-01-02", peopleDataOrdinal: 3, title: "第二篇" };

describe("RmrbReviewPage", () => {
  beforeEach(() => {
    let decided = false;
    let publishing = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/stats")) {
        return new Response(JSON.stringify({ success: true, total: 2, counts: { pending: decided ? 1 : 2, pendingPublication: decided ? 4 : 3 } }), { status: 200 });
      }
      if (url.includes("/decision") && init?.method === "POST") {
        decided = true;
        return new Response(JSON.stringify({ success: true, decision: { decision: "accept" } }), { status: 200 });
      }
      if (url.endsWith("/source")) {
        return new Response(JSON.stringify({
          success: true,
          status: "ready",
          source: "huggingface",
          message: "HF 待复核队列已就绪",
          completed: 80,
          total: 80,
          revision: "revision-1",
          cached: true,
          error: null,
        }), { status: 200 });
      }
      if (url.endsWith("/sync") && init?.method === "POST") {
        publishing = true;
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        publishing = false;
        return new Response(JSON.stringify({
          success: true,
          stagedCount: 3,
          pendingPublication: 0,
          canonicalChanges: 1,
          publishedChanges: 1,
          results: { huggingface: { commit: "abc" } },
        }), { status: 200 });
      }
      if (url.endsWith("/sync")) {
        return new Response(JSON.stringify({
          success: true,
          configured: { huggingface: true, b2: true },
          state: { targets: {} },
          progress: publishing ? {
            status: "running",
            phase: "b2",
            message: "正在更新 B2 Delivery（3/8）：manifest.jox",
            completed: 7,
            total: 12,
            percent: 73,
            startedAt: "2026-08-23T04:43:36+00:00",
            updatedAt: "2026-08-23T04:43:40+00:00",
            finishedAt: null,
            publishedChanges: 0,
          } : {
            status: "idle",
            phase: "idle",
            message: "等待发布",
            completed: 0,
            total: 0,
            percent: 0,
            startedAt: null,
            updatedAt: null,
            finishedAt: null,
            publishedChanges: 0,
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, total: decided ? 1 : 2, offset: 0, limit: 40, sort: "date-ascending", items: decided ? [second] : [first, second] }), { status: 200 });
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("submits pasted content and advances to the next pending record", async () => {
    render(<RmrbReviewPage />);
    expect(await screen.findByRole("heading", { name: "第一篇" })).toBeInTheDocument();
    const editor = screen.getByLabelText("正文");
    editor.textContent = "确认后的正文。";
    fireEvent.input(editor);
    fireEvent.click(screen.getByRole("button", { name: "Accept · 暂存" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "第二篇" })).toBeInTheDocument());
    expect(screen.getByLabelText("正文")).toHaveTextContent("");
  });

  it("accepts a clipboard image without requiring transcription text", async () => {
    render(<RmrbReviewPage />);
    await screen.findByRole("heading", { name: "第一篇" });
    const file = new File(
      [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
      "table.png",
      { type: "image/png" },
    );
    fireEvent.paste(screen.getByLabelText("正文"), {
      clipboardData: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
      },
    });
    expect(await screen.findByRole("img", { name: "table.png" })).toBeInTheDocument();
    expect(screen.getByLabelText("正文")).toContainElement(screen.getByRole("img", { name: "table.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept · 暂存" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "第二篇" })).toBeInTheDocument());

    const decisionCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input).includes("/decision"));
    const payload = JSON.parse(String(decisionCall?.[1]?.body));
    expect(payload.content).toBe("");
    expect(payload.images).toHaveLength(1);
    expect(payload.images[0]).toMatchObject({ name: "table.png", mediaType: "image/png" });
    expect(payload.images[0].dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it("accepts an image copied as People Data HTML", async () => {
    render(<RmrbReviewPage />);
    await screen.findByRole("heading", { name: "第一篇" });
    const editor = screen.getByLabelText("正文");
    const sourceUrl = "https://webvpn.zju.edu.cn/https/77726476706e69737468656265737421f4f6559d69206d5f6e048ce29b5a2e7b74a4/pic/1950/example.jpg?vpn-1";
    editor.innerHTML = `<img src="${sourceUrl}">`;
    fireEvent.input(editor);
    fireEvent.click(screen.getByRole("button", { name: "Accept · 暂存" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "第二篇" })).toBeInTheDocument());

    const decisionCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input).includes("/decision"));
    const payload = JSON.parse(String(decisionCall?.[1]?.body));
    expect(payload.content).toBe("");
    expect(payload.images).toEqual([expect.objectContaining({
      name: "example.jpg",
      mediaType: "image/jpeg",
      sourceUrl,
    })]);
  });

  it("does not reject a normal missing article without a confirmed reason", async () => {
    render(<RmrbReviewPage />);
    await screen.findByRole("heading", { name: "第一篇" });
    fireEvent.click(screen.getByRole("button", { name: "Reject · 目录无效" }));
    expect(screen.getByText("Reject 只用于确认无效的目录项，并且必须填写原因。")).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("publishes all staged data to HF and B2 with one click", async () => {
    render(<RmrbReviewPage />);
    fireEvent.click(await screen.findByRole("button", { name: "发布 3 条修订" }));
    expect(await screen.findByText(/正在更新 B2 Delivery（3\/8）/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "正在更新 B2…" })).toBeDisabled();
    expect(screen.getByRole("progressbar", { name: "发布进度" })).toHaveAttribute("aria-valuenow", "73");
    await screen.findByText("已发布 1 条修订，HF 与 B2 已同步。");

    const fetchMock = vi.mocked(fetch);
    const syncCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(syncCall).toBeTruthy();
    expect(JSON.parse(String(syncCall?.[1]?.body))).toEqual({ targets: ["huggingface", "b2"] });
  });
});
