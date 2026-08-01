import { describe, expect, it } from "vitest";
import { formatChatMarkdown, renderMarkdown } from "../src/rag/utils/markdown";

describe("RAG markdown rendering", () => {
  it("removes scripts and event handlers from backend markdown", () => {
    const html = renderMarkdown('<img src="x" onerror="alert(1)"><script>alert(2)</script>正文');

    expect(html).toContain("正文");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
  });

  it("keeps generated citation markers without accepting injected markup", () => {
    const html = formatChatMarkdown('结论 [12] <a href="javascript:alert(1)">坏链接</a>');

    expect(html).toContain('data-citation="12"');
    expect(html).not.toContain("javascript:");
  });
});
