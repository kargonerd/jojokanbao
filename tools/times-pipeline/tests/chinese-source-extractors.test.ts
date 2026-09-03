import { describe, expect, it } from "vitest";
import { discoverArticleImages } from "../src/capture/page-images.js";
import { extractArticleBody } from "../src/content/body.js";
import { attachAssetsToBody } from "../src/process/article.js";
import { extractChinanewsImages } from "../src/sources/chinanews/images.js";
import { extractChinanewsBody } from "../src/sources/chinanews/process.js";
import { extractClsImages } from "../src/sources/cls/images.js";
import { clsFetch } from "../src/sources/cls/fetch.js";
import { extractClsBody } from "../src/sources/cls/process.js";
import { extractPeopleImages } from "../src/sources/people/images.js";
import { peopleFetch } from "../src/sources/people/fetch.js";
import { extractPeopleBody } from "../src/sources/people/process.js";
import { extractThepaperImages } from "../src/sources/thepaper/images.js";
import { extractThepaperBody } from "../src/sources/thepaper/process.js";
import { extractXinhuaImages } from "../src/sources/xinhua/images.js";
import { extractXinhuaBody } from "../src/sources/xinhua/process.js";
import { extractZaobaoBody } from "../src/sources/zaobao/process.js";
import type { CapturedAsset } from "../src/types.js";

const quality = { minimumCharacters: 100, minimumParagraphs: 1 };

function capturedAsset(id: string, afterBlock: number): CapturedAsset {
  return {
    id,
    type: "image",
    role: "content",
    sourceUrl: `https://example.com/${id}.jpg`,
    rawObject: `raw/test/${id}.jpg`,
    mediaType: "image/jpeg",
    size: 1,
    sha256: id,
    afterBlock,
  };
}

describe("publisher-specific Chinese source extraction", () => {
  it("keeps Xinhua headings and turns publisher photo text into a positioned caption", () => {
    const url = "https://www.news.cn/world/20260830/example/c.html";
    const html = `<div id="detail">
      <span id="detailContent">
        <p>这是一段完整的新华网文章导语，用于交代新闻背景和图片故事发生的时间地点。</p>
        <p><span><strong>观察之一：现场情况</strong></span></p>
        <p class="image"><img src="photo.jpg" width="1200" height="800"></p>
        <p>8月30日，工作人员正在现场搬运救援物资。</p>
        <p>救援工作当天仍在有序进行，相关部门继续保障受灾群众的基本生活需要。</p>
        <p>新华社记者 张平 摄</p>
        <p>记者：测试记者</p>
      </span>
      <div>【纠错】 【责任编辑:测试】</div>
    </div>`;

    const body = extractXinhuaBody(html, quality, url);
    const images = extractXinhuaImages(html, url);

    expect(body).toContain("<h3>");
    expect(body).toContain("救援工作当天仍在有序进行");
    expect(body).not.toContain("8月30日，工作人员");
    expect(body).not.toContain("新华社记者 张平 摄");
    expect(body).not.toContain("责任编辑");
    expect(images).toEqual([expect.objectContaining({
      sourceUrl: "https://www.news.cn/world/20260830/example/photo.jpg",
      role: "content",
      afterBlock: 2,
      caption: "8月30日，工作人员正在现场搬运救援物资。 新华社记者 张平 摄",
      width: 1200,
      height: 800,
    })]);
  });

  it("marks Xinhua pagebreak photo stories as one carousel", () => {
    const url = "https://www.news.cn/world/20260830/gallery/c.html";
    const html = `<span id="detailContent">
      <p><img src="one.jpg"></p>
      <p>第一张现场照片的说明。</p><p>新华社记者 甲 摄<b style="display:none">pagebreak</b></p>
      <p><img src="two.jpg"></p>
      <p>第二张现场照片的说明。</p><p>新华社记者 乙 摄</p>
    </span>`;

    const images = extractXinhuaImages(html, url);

    expect(images).toHaveLength(2);
    expect(images.map((image) => image.presentation)).toEqual([
      { type: "carousel", id: "xinhua-primary-gallery", order: 0, total: 2 },
      { type: "carousel", id: "xinhua-primary-gallery", order: 1, total: 2 },
    ]);
  });

  it("keeps People article semantics while moving duplicate photo descriptions into captions", () => {
    const url = "http://world.people.com.cn/n1/2026/0830/example.html";
    const caption = "比什凯克国立大学孔子学院学生在课堂交流。人民网记者 褚梦琦摄";
    const html = `<div id="rm_txt_zw"><div class="rm_txt_con">
      <p><img src="/NMediaFile/2026/0830/photo.jpg" alt="${caption}" width="800" height="533"></p>
      <p>${caption}</p>
      <p>人民网比什凯克8月30日电，这是一段包含完整背景信息和现场细节的新闻正文。</p>
      <p><strong>青年眼中的中国</strong></p>
      <p>受访青年表示，学习中文为他们了解中国文化和两国合作打开了一扇新的窗口。</p>
      <p class="paper_num">分享让更多人看到<img src="/img/2020wbc/imgs/share.png"></p>
    </div></div>`;

    const body = extractPeopleBody(html, quality, url);
    const images = extractPeopleImages(html, url);

    expect(body).toContain("<h3>");
    expect(body).toContain("学习中文为他们了解中国文化");
    expect(body).not.toContain(caption);
    expect(body).not.toContain("分享让更多人看到");
    expect(images).toEqual([expect.objectContaining({
      sourceUrl: "http://world.people.com.cn/NMediaFile/2026/0830/photo.jpg",
      afterBlock: 0,
      caption,
    })]);
  });

  it("rejects People video-player controls instead of archiving them as article text", () => {
    const url = "http://society.people.com.cn/n1/2026/0902/video.html";
    const html = `<div id="rm_txt_zw"><p><span>播放器占位</span></p>
      <div id="q_v_p-example"><div class="video-js qk-videojs">
        <ul class="vjs-menu-content"><li class="vjs-menu-title">Chapters</li></ul>
        <ul class="vjs-menu-content"><li>descriptions off, selected</li></ul>
        <p class="vjs-modal-dialog-description">This is a modal window.</p>
        <p class="vjs-modal-dialog-description">Beginning of dialog window. Escape will cancel and close the window.</p>
        <p class="vjs-modal-dialog-description">End of dialog window.</p>
        <video src="movie.mp4"></video>
      </div></div>
    </div>`;

    expect(extractPeopleBody(html, quality, url)).toMatchObject({
      html: "",
      completeness: "publisher-complete",
      evidence: { kind: "unsupported-media", marker: "video-player" },
    });
    expect(extractArticleBody(html, peopleFetch, quality, extractPeopleBody, url)).toBeUndefined();
  });

  it("preserves China News subheads and captures sibling image descriptions", () => {
    const url = "https://www.chinanews.com.cn/sh/2026/08-30/example.shtml";
    const html = `<div class="left_zw">
      <p><a href="/">中新网</a>抚州8月30日电，这是一段包含足够背景信息的文章开头。</p>
      <p><strong>建强研究平台，夯实学术根基</strong></p>
      <div><img src="//i2.chinanews.com.cn/photo.jpg" width="900" height="600"></div>
      <div class="pictext">8月30日，研讨会在江西抚州举行。记者 摄</div>
      <p>中外专家围绕历史文化传承与公共文化建设进行了深入交流，并提出后续合作建议。</p>
      <table class="adInContent"><tr><td>广告</td></tr></table>
      <div class="adEditor">【编辑:测试】</div>
    </div>`;

    const body = extractChinanewsBody(html, quality, url);
    const images = extractChinanewsImages(html, url);

    expect(body).toContain("<h3>");
    expect(body).not.toContain("pictext");
    expect(body).not.toContain("广告");
    expect(images).toEqual([expect.objectContaining({
      sourceUrl: "https://i2.chinanews.com.cn/photo.jpg",
      afterBlock: 2,
      caption: "8月30日，研讨会在江西抚州举行。记者 摄",
    })]);
  });

  it("recurses through China News wrappers and preserves asset order when attached to semantic body", () => {
    const url = "https://www.chinanews.com.cn/sh/2026/08-30/nested.shtml";
    const html = `<div class="left_zw">
      <p>第一段正文交代事件背景、发生地点以及参与各方的基本情况。</p>
      <section><div class="gallery-row">
        <figure><img src="/nested-one.jpg"><figcaption>第一张现场图片说明。</figcaption></figure>
        <div><img src="/nested-two.jpg"></div><div class="pictext">第二张现场图片说明。</div>
      </div></section>
      <p>第二段正文继续说明现场进展，并补充有关部门采取的具体措施。</p>
      <div><span><img src="/nested-three.jpg"></span></div>
      <p>第三段正文记录受访者回应，并交代事件后续安排以及可能产生的影响。</p>
    </div>`;

    const body = extractChinanewsBody(html, quality, url);
    const images = extractChinanewsImages(html, url);
    expect(body).toBeDefined();
    expect(images).toMatchObject([
      { sourceUrl: "https://www.chinanews.com.cn/nested-one.jpg", afterBlock: 1, caption: "第一张现场图片说明。" },
      { sourceUrl: "https://www.chinanews.com.cn/nested-two.jpg", afterBlock: 1, caption: "第二张现场图片说明。" },
      { sourceUrl: "https://www.chinanews.com.cn/nested-three.jpg", afterBlock: 2 },
    ]);

    const archived = attachAssetsToBody(body!, images.map((image, index) =>
      capturedAsset(`nested-${index}`, image.afterBlock ?? 0)));
    expect(archived.indexOf("第一段正文")).toBeLessThan(archived.indexOf('data-asset-id="nested-0"'));
    expect(archived.indexOf('data-asset-id="nested-0"')).toBeLessThan(archived.indexOf('data-asset-id="nested-1"'));
    expect(archived.indexOf('data-asset-id="nested-1"')).toBeLessThan(archived.indexOf("第二段正文"));
    expect(archived.indexOf("第二段正文")).toBeLessThan(archived.indexOf('data-asset-id="nested-2"'));
    expect(archived.indexOf('data-asset-id="nested-2"')).toBeLessThan(archived.indexOf("第三段正文"));
  });

  it("uses The Paper publisher data for short dispatches and structures image descriptions", () => {
    const url = "https://www.thepaper.cn/newsDetail_forward_1";
    const content = `<p>据当地部门消息，搜救工作仍在继续，救援队伍正在核实最新情况。</p>
      <img data-src="https://imgpai.thepaper.cn/photo.jpg" width="1080" height="720">
      <p class="image_desc">救援人员在现场开展工作。澎湃新闻记者 图</p>
      <h4><b>扫码下载</b><b>澎湃新闻客户端</b></h4>
      <ul><li>澎湃新闻微博</li></ul>
      <img data-src="https://imgpai.thepaper.cn/client-promotion.jpg">
      <p class="image_desc">客户端推荐图片，不属于报道正文。</p>`;
    const nextData = { props: { pageProps: { detailData: { contentDetail: { content } } } } };
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>`;

    const body = extractThepaperBody(html, quality, url);
    const images = extractThepaperImages(html, url);

    expect(body).toContain("搜救工作仍在继续");
    expect(body).not.toContain("救援人员在现场开展工作");
    expect(body).not.toContain("扫码下载");
    expect(body).not.toContain("澎湃新闻微博");
    expect(images).toEqual([expect.objectContaining({
      sourceUrl: "https://imgpai.thepaper.cn/photo.jpg",
      afterBlock: 1,
      caption: "救援人员在现场开展工作。澎湃新闻记者 图",
    })]);
    expect(images.some((image) => image.sourceUrl.includes("client-promotion"))).toBe(false);
  });

  it.each([
    {
      source: "Xinhua",
      extract: () => extractXinhuaBody(
        '<div id="detailContent"><p>抱歉，您访问的页面不存在，请返回首页查看更多新闻内容。</p></div>',
        quality,
      ),
    },
    {
      source: "People",
      extract: () => extractPeopleBody(
        '<div id="rm_txt_zw"><p>抱歉，该文章已删除，请返回首页查看更多新闻内容。</p></div>',
        quality,
      ),
    },
    {
      source: "China News",
      extract: () => extractChinanewsBody(
        '<div class="left_zw"><p>内容加载失败，请稍后重试或返回首页查看更多新闻内容。</p></div>',
        quality,
      ),
    },
    {
      source: "CLS",
      extract: () => {
        const payload = { props: { pageProps: { articleDetail: {
          content: "抱歉，该稿件已下线，请返回首页查看更多财联社新闻内容。",
        } } } };
        return extractClsBody(`<script id="__NEXT_DATA__">${JSON.stringify(payload)}</script>`, quality);
      },
    },
    {
      source: "The Paper",
      extract: () => {
        const payload = { props: { pageProps: { detailData: { contentDetail: {
          content: "<p>抱歉，您访问的文章不存在，请返回首页查看更多新闻内容。</p>",
        } } } } };
        return extractThepaperBody(`<script id="__NEXT_DATA__">${JSON.stringify(payload)}</script>`, quality);
      },
    },
  ])("does not let a short $source residual page opt into the publisher threshold", ({ extract }) => {
    expect(extract()).toBeUndefined();
  });

  it("requires an unmarked The Paper discovery fragment to meet configured quality", () => {
    expect(extractThepaperBody(
      "<p>据有关部门消息，现场处置工作仍在进行，具体情况正在进一步核实。</p>",
      quality,
    )).toBeUndefined();
  });

  it("uses CLS article JSON for links and positioned images without social covers", () => {
    const url = "https://www.cls.cn/detail/1";
    const content = `<p>财联社8月30日电，<a href="/detail/2">相关公司</a>发布最新经营数据。</p>
      <p><img src="https://image.cls.cn/images/chart.png" alt="image" width="900" height="500"></p>
      <p class="image_desc">图表展示最新经营数据变化。</p>`;
    const nextData = { props: { pageProps: { articleDetail: {
      content,
      images: ["https://image.cls.cn/social-cover.jpg"],
    } } } };
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>`;

    const body = extractClsBody(html, quality, url);
    const images = extractClsImages(html, url);

    expect(body).toContain("href=\"https://www.cls.cn/detail/2\"");
    expect(body).not.toContain("图表展示最新经营数据变化");
    expect(images).toEqual([expect.objectContaining({
      sourceUrl: "https://image.cls.cn/images/chart.png",
      afterBlock: 1,
      caption: "图表展示最新经营数据变化。",
    })]);
    expect(images.some((image) => image.sourceUrl.includes("social-cover"))).toBe(false);
  });

  it("uses CLS server-rendered article HTML when Next.js data is absent", () => {
    const url = "https://www.cls.cn/detail/2469239";
    const html = `<main>
      <div class="detail-content">
        <p><strong>财联社8月31日讯</strong>这篇报道由服务端直接输出完整正文，HTTP 抓取无需等待浏览器脚本，也不会受到页面客户端资源加载状态的影响。</p>
        <p><img src="https://image.cls.cn/images/20260831/chart.png" alt="市场走势"></p>
        <p>第二段继续说明市场变化、行业背景以及后续值得关注的具体影响，并补充相关公司的公开回应和时间节点。</p>
      </div>
    </main>`;

    const body = extractArticleBody(html, clsFetch, quality, extractClsBody, url);
    const images = discoverArticleImages(html, url, extractClsImages);

    expect(body).toContain("服务端直接输出完整正文");
    expect(body).toContain("第二段继续说明市场变化");
    expect(images).toEqual([expect.objectContaining({
      sourceUrl: "https://image.cls.cn/images/20260831/chart.png",
      role: "content",
      afterBlock: 1,
      alt: "市场走势",
    })]);
  });

  it("removes Zaobao recommendation cards and orphan extension headings", () => {
    const url = "https://www.zaobao.com.sg/news/world/story20260830-1";
    const html = `<article><div class="articleBody"><div>
      <p>第一段正文说明事件背景，并包含足够多的具体信息用于验证联合早报正文边界。</p>
      <h2>延伸阅读</h2>
      <div class="bff-recommend-article"><p>推荐文章不属于正文内容。</p></div>
      <p>第二段正文继续报道事件进展，说明有关部门已经采取的后续行动和应对措施。</p>
      <p>第三段正文补充受访者回应，以及这项事件接下来可能产生的实际影响。</p>
    </div></div></article>`;

    const body = extractZaobaoBody(html, { minimumCharacters: 100, minimumParagraphs: 3 }, url);

    expect(body).toContain("第二段正文继续报道");
    expect(body).not.toContain("延伸阅读");
    expect(body).not.toContain("推荐文章不属于正文");
  });
});
