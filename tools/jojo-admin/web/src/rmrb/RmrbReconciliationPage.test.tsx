import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RmrbReconciliationPage } from "./RmrbReconciliationPage";

const first = {
  sourceKey: "1946-07-23|1|21",
  date: "1946-07-23",
  page: 1,
  ordinal: 21,
  title: "梁漱溟发表谈话",
  content: "JSONL 正文。",
  signals: ["suspected_title_typo"],
  signalLabels: ["疑似一字之差"],
  sourcePageHref: "https://example.test/19460723/1",
  candidates: [{
    candidateKey: "1946-07-24|1|9",
    date: "1946-07-24",
    page: 1,
    ordinal: 9,
    title: "梁潄溟发表谈话",
    editDistance: 1,
    relations: ["suspected_title_typo", "adjacent_date"],
    peopleDataHref: "https://example.test/candidate",
  }],
};
const second = {
  ...first,
  sourceKey: "1946-07-31|2|24",
  date: "1946-07-31",
  page: 2,
  ordinal: 24,
  title: "另一篇",
  candidates: [],
};

describe("RmrbReconciliationPage", () => {
  beforeEach(() => {
    let decided = false;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        decided = true;
        return new Response(JSON.stringify({
          success: true,
          decision: { resolution: "merge_candidate", reviewedAt: "2026-08-24T00:00:00Z" },
        }), { status: 200 });
      }
      const items = decided ? [second] : [first, second];
      return new Response(JSON.stringify({
        success: true,
        source: "review.jsonl",
        decisions: "decisions.jsonl",
        total: items.length,
        offset: 0,
        limit: 30,
        sort: "date-ascending",
        items,
        counts: {
          total: 2,
          pending: decided ? 1 : 2,
          reviewed: decided ? 1 : 0,
          jsonlCorrect: 0,
          mergeCandidate: decided ? 1 : 0,
          manualMetadata: 0,
          deferred: 0,
        },
      }), { status: 200 });
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("shows title evidence and advances after merging a candidate", async () => {
    render(<RmrbReconciliationPage />);
    expect(await screen.findByRole("heading", { name: "梁漱溟发表谈话" })).toBeInTheDocument();
    expect(screen.getByText((_, node) => (
      node?.tagName === "H3" && node.textContent === "梁潄溟发表谈话"
    ))).toBeInTheDocument();
    expect(screen.getByLabelText("日期不同：JSONL 1946-07-23，人民数据 1946-07-24")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "合并到这个候选" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "另一篇" })).toBeInTheDocument());

    const decisionCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(decisionCall?.[1]?.body))).toMatchObject({
      date: "1946-07-23",
      page: 1,
      ordinal: 21,
      resolution: "merge_candidate",
      candidateKey: "1946-07-24|1|9",
    });
  });

  it("keeps manual metadata behind an explicit control", async () => {
    render(<RmrbReconciliationPage />);
    await screen.findByRole("heading", { name: "梁漱溟发表谈话" });
    expect(screen.queryByDisplayValue("1946-07-23")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /手工修正日期/ }));
    expect(await screen.findByDisplayValue("1946-07-23")).toBeInTheDocument();
    expect(screen.getByDisplayValue("梁漱溟发表谈话")).toBeInTheDocument();
  });
});
