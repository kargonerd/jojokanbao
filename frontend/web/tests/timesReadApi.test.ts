import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("../src/account/auth", () => ({ authClient: { rpc } }));

import {
  loadTimesArticleReads,
  markTimesArticleRead,
  markTimesArticleUnread,
} from "../src/times/readApi";

beforeEach(() => vi.clearAllMocks());

describe("Times read RPC API", () => {
  it("maps a batch of database rows", async () => {
    rpc.mockResolvedValue({
      data: [{ article_id: "article-1", read_at: "2026-08-29T08:00:00Z" }],
      error: null,
    });

    await expect(loadTimesArticleReads(["article-1", "article-2"])).resolves.toEqual([
      { articleId: "article-1", readAt: "2026-08-29T08:00:00Z" },
    ]);
    expect(rpc).toHaveBeenCalledWith("get_my_times_article_reads", {
      p_article_ids: ["article-1", "article-2"],
    });
  });

  it("uses narrow RPCs for read and unread writes", async () => {
    rpc.mockResolvedValue({ data: null, error: null });

    await markTimesArticleRead("article-1", "2026-08-29");
    await markTimesArticleUnread("article-1");

    expect(rpc).toHaveBeenNthCalledWith(1, "mark_my_times_article_read", {
      p_article_id: "article-1",
      p_issue_date: "2026-08-29",
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "mark_my_times_article_unread", {
      p_article_id: "article-1",
    });
  });
});
