import { describe, expect, it } from "vitest";
import { searchResultQuote, searchResultTitle, withSearchLocation } from "../src/search-location";

describe("search location links", () => {
  it("preserves a complete long title instead of extracting a keyword snippet", () => {
    const title = `${"前言".repeat(100)}教育者要先受教育……后记`;
    const cleaned = searchResultTitle(title.replace("教育者", "<mark>教\n育</mark>者"));
    expect(cleaned).toBe(title.replace("教育者", "教 育者"));
    const url = new URL(withSearchLocation("/archive/rmrb/19651212#page-2", {
      query: "教育", title: cleaned, page: 2,
    }), "https://reader.test");
    expect(url.searchParams.get("title")).toBe(cleaned);
    expect(url.searchParams.has("quote")).toBe(false);
    expect(searchResultTitle("@highlight@教育@/highlight@者要先受教育")).toBe("教育者要先受教育");
  });
  it("retains an explicitly missing title without replacing it with a query", () => {
    const url = new URL(withSearchLocation("/archive/rmrb/19651212", { query: "教育", title: "" }), "https://reader.test");
    expect(url.searchParams.get("title")).toBe("");
  });
  it("keeps a contiguous highlighted snippet instead of joining distant results", () => {
    expect(searchResultQuote("前一条无关摘录\n…\n修建<mark>铁路</mark>的记录\n…\n另一段铁路", "铁路")).toBe("修建铁路的记录");
    expect(searchResultQuote("@highlight@铁路@/highlight@建设", "铁路")).toBe("铁路建设");
  });
  it("keeps the query inside a long excerpt and caps URL text", () => {
    const quote = searchResultQuote(`${"甲".repeat(300)}铁路${"乙".repeat(300)}`, "铁路");
    expect(quote).toContain("铁路");
    expect(quote.length).toBeLessThanOrEqual(120);
  });
  it("preserves chapter queries, page hashes, and search filters", () => {
    const result = new URL(withSearchLocation("/book/test/one?chapter=chapter-1#page-2", {
      query: "铁路", quote: "修建铁路", page: 2, returnTo: "/search?keyword=铁路&page=3",
    }), "https://reader.test");
    expect(result.pathname).toBe("/book/test/one");
    expect(result.hash).toBe("#page-2");
    expect(Object.fromEntries(result.searchParams)).toEqual({
      chapter: "chapter-1", query: "铁路", quote: "修建铁路", searchPage: "2", returnTo: "/search?keyword=铁路&page=3",
    });
  });
  it("keeps mobile absolute reader URLs and ignores unsafe return destinations", () => {
    expect(withSearchLocation("https://reader.test/archive/rmrb/19660701#page-3", { query: "", returnTo: "//other.test" }))
      .toBe("https://reader.test/archive/rmrb/19660701#page-3");
  });
});
