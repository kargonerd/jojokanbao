import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import { convertWereadChapter } from "../src/semantic-html";

function convert(content: string, stylesheets: string[] = []) {
  return cheerio.load(convertWereadChapter({
    id: "chapter:weight", sourceCid: "weight", sourceFiles: [], title: "样式", order: 1, level: 1,
    contentType: "application/xhtml+xml", content: `<html><body>${content}</body></html>`, stylesheets,
  }, []).chapter.body.value);
}

describe("source font weight", () => {
  it("preserves publisher stylesheet bold without retaining its CSS or changing the text", () => {
    const $ = convert('<p class="content-c1">1报告</p><p class="content">正文</p>', [
      '.content-c1 { font-family: "Publisher Font"; text-align: center; font-weight: bold; }',
    ]);
    expect($("p").first().attr("data-align")).toBe("center");
    expect($("p strong").text()).toBe("1报告");
    expect($("p").last().html()).toBe("正文");
    expect($.html()).not.toMatch(/style=|class=|Publisher Font/);
  });

  it("honors specificity, importance, source order and inline overrides", () => {
    const $ = convert('<p id="target" class="title">ID</p><p class="title inline" style="font-weight:400">普通</p><p class="title priority" style="font-weight:400">重点</p><p class="numeric">数值</p>', [
      '#target {font-weight:700}.title {font-weight:normal}.title {font-weight:bold}.priority {font-weight:800!important}.numeric {font-weight:650}',
    ]);
    expect($("#target strong").text()).toBe("ID");
    // This fixture uses a neutral class to avoid publisher semantic aliases.
    expect($("p").eq(1).find("strong")).toHaveLength(0);
    expect($("p").eq(2).find("strong").text()).toBe("重点");
    expect($("p").eq(3).find("strong").text()).toBe("数值");
  });

  it("preserves inherited bold with normal-weight spans and existing inline emphasis", () => {
    const $ = convert('<div class="heavy"><p>加粗<em>斜体</em><span style="font-weight:normal">普通</span></p><p style="font-weight:400"><b style="font-weight:inherit">普通粗体标签</b><b>显式粗体</b></p></div>', ['.heavy{font-weight:700}']);
    expect($("p").first().find("strong").map((_index, element) => $(element).text()).get()).toEqual(["加粗", "斜体"]);
    expect($("p").last().find("strong").text()).toBe("显式粗体");
    expect($("p").first().text()).toBe("加粗斜体普通");
  });

  it("handles tag/class/ID combinators and selector lists without importing dynamic CSS", () => {
    const $ = convert('<style>.section > p.mark, #other {font-weight: bold} p:hover{font-weight:900} @media print {p {font-weight:900}}</style><div class="section"><p class="mark">组合</p></div><p id="other">列表</p><p>普通</p>');
    expect($("strong").map((_index, element) => $(element).text()).get()).toEqual(["组合", "列表"]);
    expect($("style")).toHaveLength(0);
  });
});
