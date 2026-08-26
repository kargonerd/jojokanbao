import { describe, expect, it } from "vitest";
import { formatChatMarkdown, renderMarkdown } from "../src/rag/utils/markdown";

describe("RAG markdown rendering", () => {
  it("removes scripts and event handlers from backend markdown", () => {
    const html = renderMarkdown('<img src="x" onerror="alert(1)"><script>alert(2)</script>正文');

    expect(html).toContain("正文");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
  });

  it("does not turn an unattached bracket number into a link or accept injected markup", () => {
    const html = formatChatMarkdown('结论 [12] <a href="javascript:alert(1)">坏链接</a>');

    expect(html).toContain("[12]");
    expect(html).not.toContain('data-citation="12"');
    expect(html).not.toContain("javascript:");
  });

  it("turns evidence tokens into numbered reader links beside the supported claim", () => {
    const html = formatChatMarkdown("这句话有原文依据。[cite:Jabc]", [{
      citationId: "Jabc",
      datasetId: "mao",
      itemId: "volume-1",
      targetId: "chapter:15",
      anchorId: "paragraph:2",
      title: "第15章 长征",
    }]);

    expect(html).toContain('data-citation="1"');
    expect(html).toContain("jojo-citation");
    expect(html).toContain("text-red");
    expect(html).toContain('target="_blank"');
    expect(html).toContain("chapter=chapter%3A15");
    expect(html).not.toContain("cite:Jabc");
  });
});
