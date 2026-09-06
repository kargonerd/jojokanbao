import { describe, expect, it } from "vitest";
import { chinanewsDeliveryIdentity } from "../src/sources/chinanews/identity.js";
import { sourceDeliveryIdentity } from "../src/sources/registry.js";

describe("China News publisher identity", () => {
  it("recognizes dated manuscript aliases without assigning a fabricated canonical URL", () => {
    for (const section of ["gn", "cj", "gj", "sh"]) {
      expect(chinanewsDeliveryIdentity(`https://www.chinanews.com.cn/${section}/2026/09-06/10691490.shtml`)).toBe("2026-09-06/10691490");
    }
    expect(chinanewsDeliveryIdentity("http://chinanews.com.cn/sh/2026/09-06/10691490.shtml?utm_source=share#body")).toBe("2026-09-06/10691490");
    expect(sourceDeliveryIdentity("chinanews", "https://www.chinanews.com.cn/gj/2026/09-06/10691490.shtml")).toBe("2026-09-06/10691490");
    expect(sourceDeliveryIdentity("reuters", "https://www.chinanews.com.cn/gj/2026/09-06/10691490.shtml")).toBeUndefined();
  });

  it("does not collapse different manuscripts or dates", () => {
    const original = chinanewsDeliveryIdentity("https://www.chinanews.com.cn/sh/2026/09-06/10691490.shtml");
    expect(chinanewsDeliveryIdentity("https://www.chinanews.com.cn/sh/2026/09-06/10691491.shtml")).not.toBe(original);
    expect(chinanewsDeliveryIdentity("https://www.chinanews.com.cn/sh/2026/09-05/10691490.shtml")).not.toBe(original);
  });

  it.each([
    "not a URL", "https://example.test/sh/2026/09-06/10691490.shtml",
    "https://www.chinanews.com.cn.example.test/sh/2026/09-06/10691490.shtml",
    "https://image.chinanews.com.cn/sh/2026/09-06/10691490.shtml",
    "https://www.chinanews.com.cn/photo/2026/09-06/10691490.shtml",
    "https://www.chinanews.com.cn/sh/2026/02-31/10691490.shtml",
    "https://www.chinanews.com.cn/sh/2026/09-06/index.shtml",
    "ftp://www.chinanews.com.cn/sh/2026/09-06/10691490.shtml",
  ])("leaves unsupported URL identities alone: %s", (url) => {
    expect(chinanewsDeliveryIdentity(url)).toBeUndefined();
  });
});
