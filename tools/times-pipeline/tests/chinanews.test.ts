import { describe, expect, it } from "vitest";
import { discoverArticleImages } from "../src/capture/page-images.js";
import { chinanewsFetch } from "../src/sources/chinanews/fetch.js";
import { extractChinanewsImages } from "../src/sources/chinanews/images.js";
import { extractChinanewsBody } from "../src/sources/chinanews/process.js";

const articlePage = `
  <div id="cont_1_1_2">
    <div class="download_wrapper"><img src="/images/app-download.jpg" width="900" height="200"></div>
    <div class="content_maincontent_content">
      <div class="left_zw">
        <p>中新网南宁8月29日电，广西水文中心监测显示，受强降雨影响，多条河流出现明显涨水过程。</p>
        <p>未来二十四小时，部分中小河流可能继续出现超警洪水，相关部门已加强监测预警和巡查防守。（完）</p>
        <figure><img src="/images/flood-scene.jpg" alt="洪水现场" width="640" height="360"></figure>
        <table class="adInContent"><tr><td>客户端推广内容不属于新闻正文</td></tr></table>
        <div class="adEditor">【编辑：张子怡】</div>
        <div id="function_code_page">分享与打印</div>
      </div>
      <div class="channel">更多精彩内容请进入社会新闻</div>
    </div>
    <div class="selected_news_wrapper">
      <p>推荐阅读：一支足球队参加比赛</p>
      <img src="/images/football-team.jpg" width="800" height="500">
    </div>
  </div>`;

describe("China News article boundaries", () => {
  it("extracts only publisher article paragraphs", () => {
    const body = extractChinanewsBody(articlePage, { minimumCharacters: 80, minimumParagraphs: 2 });

    expect(body).toContain("广西水文中心监测显示");
    expect(body).toContain("（完）");
    expect(body).not.toContain("客户端推广");
    expect(body).not.toContain("编辑");
    expect(body).not.toContain("推荐阅读");
  });

  it("keeps inline article images but excludes app and recommendation images", () => {
    const images = discoverArticleImages(
      articlePage,
      "https://www.chinanews.com.cn/sh/2026/08-29/10686419.shtml",
      chinanewsFetch,
    );

    expect(images.map((image) => image.sourceUrl)).toEqual([
      "https://www.chinanews.com.cn/images/flood-scene.jpg",
    ]);
  });

  it("does not let generic fallback reintroduce an inline publisher ad", () => {
    const url = "https://www.chinanews.com.cn/cj/2026/09-02/10688570.shtml";
    const html = `<div class="left_zw">
      <p>中新网北京9月2日电，这是一段足够长的新闻正文，用于确认页面已经进入真实的文章内容区域。</p>
      <p>第二段继续说明新闻事件，而不是任何广告或者推荐内容。</p>
      <table class="adInContent"><tbody><tr><td>
        <img src="/ad2008/U947P4T175D633F27513DT20260901095008.jpg" width="370" height="280" alt="境外消费广告">
      </td></tr></tbody></table>
    </div>`;

    expect(extractChinanewsImages(html, url)).toEqual([]);
    expect(discoverArticleImages(html, url, chinanewsFetch, extractChinanewsImages)).toEqual([]);
  });

  it("keeps a publisher-owned image-only live poster as the complete report", () => {
    const url = "https://www.chinanews.com.cn/gn/2026/08-31/10687338.shtml";
    const html = `<main>
      <h1>直播海报：直击开学第一天</h1>
      <div class="left_zw">
        <div><img src="//i2.chinanews.com.cn/simg/cmshd/2026/08/31/poster.jpg" alt=""></div>
        <div class="adEditor">【编辑:何颖】</div>
      </div>
    </main>`;

    expect(extractChinanewsBody(html, { minimumCharacters: 800, minimumParagraphs: 3 }, url))
      .toBe('<figure data-publisher-image-only="true"></figure>');
    expect(discoverArticleImages(html, url, chinanewsFetch, extractChinanewsImages)).toEqual([
      expect.objectContaining({
        sourceUrl: "https://i2.chinanews.com.cn/simg/cmshd/2026/08/31/poster.jpg",
        role: "content",
        afterBlock: 0,
      }),
    ]);
  });

  it("does not relax extraction for arbitrary image shells or poster titles without an image", () => {
    const quality = { minimumCharacters: 800, minimumParagraphs: 3 };
    const pageUrl = "https://www.chinanews.com.cn/gn/2026/08-31/example.shtml";

    expect(extractChinanewsBody(
      '<h1>普通新闻标题</h1><div class="left_zw"><img src="//i2.chinanews.com.cn/photo.jpg"></div>',
      quality,
      pageUrl,
    )).toBeUndefined();
    expect(extractChinanewsBody(
      '<h1>直播海报：今日活动</h1><div class="left_zw"><div class="adEditor">【编辑:测试】</div></div>',
      quality,
      pageUrl,
    )).toBeUndefined();
  });

  it("rejects image-only poster shells with multiple, external, or residual prose content", () => {
    const quality = { minimumCharacters: 800, minimumParagraphs: 3 };
    const pageUrl = "https://www.chinanews.com.cn/gn/2026/08-31/example.shtml";
    const invalidImageShells = [
      `<h1>直播海报：两张图片</h1><div class="left_zw">
        <img src="//i1.chinanews.com.cn/one.jpg"><img src="//i2.chinanews.com.cn/two.jpg">
      </div>`,
      `<h1>直播海报：混合来源</h1><div class="left_zw">
        <img src="//i1.chinanews.com.cn/one.jpg"><img src="https://media.example.org/neighbor.jpg">
      </div>`,
    ];

    for (const html of invalidImageShells) {
      expect(extractChinanewsBody(html, quality, pageUrl)).toBeUndefined();
      expect(extractChinanewsImages(html, pageUrl)).toEqual([]);
    }

    const residualProse = `<h1>直播海报：尚有短正文</h1><div class="left_zw">
      <p>开学第一天现场。</p><img src="//i1.chinanews.com.cn/one.jpg">
    </div>`;
    expect(extractChinanewsBody(residualProse, quality, pageUrl)).toBeUndefined();
  });
});
