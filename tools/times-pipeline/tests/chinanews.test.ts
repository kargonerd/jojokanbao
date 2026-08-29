import { describe, expect, it } from "vitest";
import { discoverArticleImages } from "../src/capture/page-images.js";
import { chinanewsFetch } from "../src/sources/chinanews/fetch.js";
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
});
