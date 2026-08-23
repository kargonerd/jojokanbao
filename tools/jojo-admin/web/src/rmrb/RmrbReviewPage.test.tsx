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
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/stats")) {
        return new Response(JSON.stringify({ success: true, total: 2, counts: { pending: decided ? 1 : 2, accept: decided ? 1 : 0, reject: 0 } }), { status: 200 });
      }
      if (url.includes("/decision") && init?.method === "POST") {
        decided = true;
        return new Response(JSON.stringify({ success: true, decision: { decision: "accept" } }), { status: 200 });
      }
      if (url.endsWith("/sync") && init?.method === "POST") {
        return new Response(JSON.stringify({
          success: true,
          recordCount: 7,
          sha256: "digest",
          results: { huggingface: { commit: "abc" } },
        }), { status: 200 });
      }
      if (url.endsWith("/sync")) {
        return new Response(JSON.stringify({
          success: true,
          configured: { huggingface: true, b2: true },
          remotePath: "newspapers/rmrb/annotations",
          state: { targets: {} },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, total: decided ? 1 : 2, offset: 0, limit: 40, sort: "date-ascending", items: decided ? [second] : [first, second] }), { status: 200 });
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("submits pasted content and advances to the next pending record", async () => {
    render(<RmrbReviewPage />);
    expect(await screen.findByRole("heading", { name: "第一篇" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("正文"), { target: { value: "确认后的正文。" } });
    fireEvent.click(screen.getByRole("button", { name: "Accept · 暂存" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "第二篇" })).toBeInTheDocument());
    expect(screen.getByLabelText("正文")).toHaveValue("");
  });

  it("syncs the local review ledger only to selected destinations", async () => {
    render(<RmrbReviewPage />);
    const hf = await screen.findByRole("checkbox", { name: "HF" });
    fireEvent.click(hf);
    fireEvent.click(screen.getByRole("button", { name: "立即同步" }));
    await screen.findByText("已将 7 条人工记录同步到 Hugging Face。");

    const fetchMock = vi.mocked(fetch);
    const syncCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(syncCall).toBeTruthy();
    expect(JSON.parse(String(syncCall?.[1]?.body))).toEqual({ targets: ["huggingface"] });
  });
});
