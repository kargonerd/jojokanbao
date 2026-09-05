import { describe, expect, it, vi } from "vitest";
vi.mock("expo-crypto", () => ({}));
vi.mock("./featureFlag", () => ({ mobileSpeechAllowed: () => false }));
import { mobileSpeechSegments, nativeSpeechHtmlBlocks, speechTime } from "./speech";

describe("native speech text", () => {
  it("uses the same leaf blocks as the browser and batch planner", () => {
    const html = '<h1>第一章</h1><blockquote><p>甲 &amp; 乙<sup>注</sup>。</p><p>丙。</p></blockquote><figure>图片说明</figure><p data-role="note">注释</p><p>丁。</p>';
    expect(nativeSpeechHtmlBlocks(html)).toEqual(["第一章", "甲 & 乙。", "丙。", "丁。"]);
    expect(mobileSpeechSegments("第一章", html, "html")).toEqual(["第一章", "甲 & 乙。丙。丁。"]);
  });
  it("keeps line breaks, entities, exclusions and fallback text consistent", () => {
    expect(nativeSpeechHtmlBlocks('<div>甲<br>乙&nbsp;丙<script>bad</script></div>')).toEqual(["甲乙 丙"]);
    expect(mobileSpeechSegments("标题", "第一段。\n\n第二段。", "text")).toEqual(["标题", "第一段。第二段。"]);
    expect(speechTime(75.2)).toBe("01:15");
  });
});
