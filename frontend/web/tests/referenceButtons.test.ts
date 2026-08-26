import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReferenceButtons, answerCitations, referenceHref } from "../src/rag/components/ReferenceButtons";

afterEach(() => cleanup());

describe("referenceHref", () => {
  it("builds a reader URL that restores the chapter and highlighted quote", () => {
    const href = referenceHref({
      datasetId: "book/a",
      itemId: "book:a item",
      targetId: "chapter:2",
      anchorId: "paragraph:7",
      excerpt: "…  劳动\n创造价值  …",
    });
    expect(href).toBe(
      "/book/book%2Fa/book%3Aa%20item?chapter=chapter%3A2&anchor=paragraph%3A7&quote=%E5%8A%B3%E5%8A%A8+%E5%88%9B%E9%80%A0%E4%BB%B7%E5%80%BC",
    );
  });

  it("does not pretend a citation is navigable without a full book location", () => {
    expect(referenceHref({ targetId: "chapter:2" })).toBeUndefined();
  });

  it("opens a cited reader location in a new tab", () => {
    render(createElement(ReferenceButtons, {
      references: [{
        datasetId: "book-a",
        itemId: "book-a:item-a",
        targetId: "chapter:1",
        anchorId: "paragraph:2",
        title: "第一章",
      }],
    }));

    const link = screen.getByRole("link", { name: /第一章/ });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("href")).toContain("anchor=paragraph%3A2");
  });

  it("shows only references used inline and groups repeated anchors from one chapter", () => {
    const references = [
      { citationId: "Ja", datasetId: "book-a", itemId: "volume-a", itemTitle: "毛泽东传 第1卷", targetId: "chapter:15", anchorId: "p:1", title: "第15章 长征" },
      { citationId: "Jb", datasetId: "book-a", itemId: "volume-a", itemTitle: "毛泽东传 第1卷", targetId: "chapter:15", anchorId: "p:8", title: "第15章 长征" },
      { citationId: "Junused", datasetId: "book-a", itemId: "volume-a", targetId: "chapter:18", title: "第18章" },
    ];

    expect(answerCitations("第一点[cite:Ja]，第二点[cite:Jb]。", references)).toHaveLength(2);
    render(createElement(ReferenceButtons, {
      content: "第一点[cite:Ja]，第二点[cite:Jb]。",
      references,
    }));

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]?.textContent).toContain("[1, 2]");
    expect(links[0]?.textContent).toContain("《毛泽东传 第1卷》 · 第15章 长征");
    expect(screen.queryByText(/第18章/)).toBeNull();
  });
});
