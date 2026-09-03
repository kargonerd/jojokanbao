import { describe, expect, it } from "vitest";
import { discoverArticleImages } from "../src/capture/page-images.js";
import { extractArticleBody } from "../src/content/body.js";
import { zaobaoFetch } from "../src/sources/zaobao/fetch.js";
import { extractZaobaoImages } from "../src/sources/zaobao/images.js";
import { extractZaobaoBody } from "../src/sources/zaobao/process.js";

const pageUrl = "https://www.zaobao.com.sg/news/china/story20260829-9595968";
const cassette = "https://cassette.sphdigital.com.sg/image/zaobao";
const page = `<html><head>
  <meta property="og:image" content="${cassette}/sharing-card">
</head><body><article>
  <div class="my-[16px] text-[14px]"><img src="${cassette}/lead?f=webp&amp;o=zbimg" alt="朱忠明出任市政府党组书记。（互联网）"></div>
  <div class="articleBody text-[18px]">
    <p>中共上海市委副书记朱忠明已出任市政府党组书记，按惯例下一步预计将出任上海市长。</p>
    <div class="bff-recommend-article"><p>推荐阅读文章不属于这篇新闻正文。</p><img src="${cassette}/recommendation" alt="推荐文章"></div>
    <p>上海发布消息称，朱忠明星期六以市委副书记、市政府党组书记身份主持召开会议。</p>
    <div class="inline-figure bff-inline-image">
      <div class="figure-media"><img src="${cassette}/inline" width="1200" height="800" alt="会议现场图片说明"></div>
      <div class="figure-caption">会议现场的完整图片说明。（早报摄）</div>
    </div>
    <h2>下一步人事安排</h2>
    <p>公开资料显示，他长期在财政系统工作，并曾在多个地方岗位任职。</p>
  </div>
  <img src="/assets/tag-icon.webp" alt="tag icon">
  <img src="/assets/newspost.svg" alt="">
</article></body></html>`;

describe("Zaobao semantic article capture", () => {
  it("keeps only article body semantics and removes recommendation cards", () => {
    const body = extractArticleBody(
      page,
      zaobaoFetch,
      { minimumCharacters: 100, minimumParagraphs: 3 },
      extractZaobaoBody,
      pageUrl,
    );

    expect(body).toContain("朱忠明已出任市政府党组书记");
    expect(body).toContain("<h2>下一步人事安排</h2>");
    expect(body).not.toContain("推荐阅读文章");
    expect(body).not.toContain("会议现场的完整图片说明");
  });

  it("keeps the publisher lead and inline figures without page chrome or duplicates", () => {
    const images = discoverArticleImages(page, pageUrl, extractZaobaoImages);

    expect(images.map((image) => image.sourceUrl)).toEqual([
      `${cassette}/lead?f=webp&o=zbimg`,
      `${cassette}/inline`,
    ]);
    expect(images[0]).toMatchObject({
      role: "lead",
      caption: "朱忠明出任市政府党组书记。（互联网）",
    });
    expect(images[1]).toMatchObject({
      role: "content",
      caption: "会议现场的完整图片说明。（早报摄）",
      afterBlock: 2,
      width: 1200,
      height: 800,
    });
    expect(images.some((image) => /sharing-card|recommendation|tag-icon|newspost/u.test(image.sourceUrl))).toBe(false);
  });
});
