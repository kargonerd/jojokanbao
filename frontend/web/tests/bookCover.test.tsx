import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BookCover } from "../src/library/BookCover";

const contentMocks = vi.hoisted(() => ({
  loadBookCoverUrl: vi.fn(),
}));

vi.mock("../src/rag/content", () => ({
  loadBookCoverUrl: contentMocks.loadBookCoverUrl,
}));

afterEach(() => {
  cleanup();
  contentMocks.loadBookCoverUrl.mockReset();
});

describe("BookCover", () => {
  it("does not paint a fake cover while loading and reuses the decoded cover after remount", async () => {
    let resolveCover!: (url: string) => void;
    contentMocks.loadBookCoverUrl.mockReturnValue(new Promise((resolve) => { resolveCover = resolve; }));

    const first = render(
      <BookCover title="缓存测试书" tone="red" datasetId="cache-test" itemKey="volume-1" />,
    );
    expect(screen.queryByText("缓存测试书")).toBeNull();
    expect(first.container.querySelector(".book-cover")?.className).toContain("is-loading");

    await act(async () => { resolveCover("blob:cached-cover"); });
    await waitFor(() => expect(first.container.querySelector("img")?.getAttribute("src")).toBe("blob:cached-cover"));
    first.unmount();

    const second = render(
      <BookCover title="缓存测试书" tone="red" datasetId="cache-test" itemKey="volume-1" />,
    );
    expect(second.container.querySelector("img")?.getAttribute("src")).toBe("blob:cached-cover");
    expect(contentMocks.loadBookCoverUrl).toHaveBeenCalledTimes(1);
  });
});
