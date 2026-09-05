import { describe, expect, it } from "vitest";
import { speechSegments } from "@jojo/content";
import { speechHtmlBlocks } from "../src/speech-plan-cli";

describe("manual speech planning", () => {
  it("uses the reader's segmentation and excludes figures and notes", () => {
    const html = '<h1>第一章</h1><p>这是第一段。</p><figure><figcaption>图片说明</figcaption></figure>'
      + '<p>这是第二段。<sup>1</sup></p><p data-role="note">不应朗读</p>';
    expect(speechSegments("第一章", html, "html", 500, speechHtmlBlocks)).toEqual(["第一章", "这是第一段。这是第二段。"]);
  });
  it("ignores empty containers and avoids duplicating nested block text", () => {
    expect(speechHtmlBlocks('<blockquote><p>引文</p></blockquote><div></div>')).toEqual(["引文"]);
  });
  it("splits overlong titles as well as body content under the API limit", () => {
    expect(speechSegments("标题".repeat(500), "正文", "text").every((text) => text.length <= 500)).toBe(true);
  });
});
