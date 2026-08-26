import { describe, expect, it } from "vitest";
import { extractRenderedBody } from "../src/process/rendered-body.js";

describe("rendered article processing", () => {
  it("extracts only Reuters-owned paragraph and list blocks from rendered DOM", () => {
    const intro = `<div data-testid="paragraph-0">${"Reuters introduction. ".repeat(20)}</div>`;
    const details = Array.from({ length: 4 }, (_, index) =>
      `<div data-testid="unordered-0"><div data-testid="Body">${`Article detail ${index}. `.repeat(15)}</div></div>`
    ).join("");
    const unrelated = '<div data-testid="Body">Company widget that must not be included.</div>';
    const body = extractRenderedBody(`<html><body>${intro}${details}${unrelated}</body></html>`, {
      capture: "browser",
      bodySelectors: [
        "[data-testid^='paragraph-'], [data-testid^='unordered-'] [data-testid='Body'], [data-testid='SignOff'] [data-testid='Body']",
      ],
    });

    expect(body?.match(/<p>/gu)).toHaveLength(5);
    expect(body).not.toContain("Company widget");
  });

  it("uses the source's quality threshold for short complete news articles", () => {
    const body = extractRenderedBody("<article><p>这是一篇完整但很短的快讯正文，来源会明确允许单段短稿进入全文。</p></article>", undefined, {
      minimumCharacters: 20,
      minimumParagraphs: 1,
    });

    expect(body).toContain("完整但很短的快讯正文");
  });

  it("uses the complete source-owned container when an article mixes paragraphs and text nodes", () => {
    const body = extractRenderedBody(
      `<div id="publisher-body">${"正文直接文本。".repeat(30)}<p>来源信息不会让直接文本丢失。</p></div>`,
      { capture: "browser", bodySelectors: ["#publisher-body"] },
      { minimumCharacters: 100, minimumParagraphs: 1 },
    );

    expect(body).toContain("正文直接文本");
  });

  it("delegates Bloomberg's embedded body format to its publisher process module", () => {
    const nextData = {
      props: { pageProps: { story: { body: { content: [
        { type: "text", value: "First Bloomberg paragraph contains enough text for extraction." },
        { type: "ad", content: [{ type: "text", value: "Advertisement must be ignored completely." }] },
        { type: "text", value: "Second Bloomberg paragraph also belongs to the article body." },
      ] } } } },
    };
    const body = extractRenderedBody(
      `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>`,
      { capture: "browser", bodySelectors: [], bodyExtractor: "bloomberg-next-data" },
      { minimumCharacters: 50, minimumParagraphs: 2 },
    );

    expect(body).toContain("First Bloomberg paragraph");
    expect(body).toContain("Second Bloomberg paragraph");
    expect(body).not.toContain("Advertisement");
  });
});
