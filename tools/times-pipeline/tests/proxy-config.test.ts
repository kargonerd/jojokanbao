import { describe, expect, it } from "vitest";
import { buildMihomoConfig, parseProxySubscription } from "../src/proxy-config.js";

describe("proxy configuration", () => {
  it("keeps unique named nodes", () => {
    const parsed = parseProxySubscription(`
proxies:
  - name: node-a
    type: socks5
    server: example.test
    port: 1080
  - name: node-a
    type: socks5
    server: duplicate.test
    port: 1080
`);
    expect(parsed.proxies.map((node) => node.name)).toEqual(["node-a"]);
  });

  it("uses a generic error for invalid subscription data", () => {
    expect(() => parseProxySubscription("secret-token: [")).toThrow("not valid Clash YAML");
    try {
      parseProxySubscription("secret-token: [");
    } catch (error) {
      expect(String(error)).not.toContain("secret-token");
    }
  });

  it("allows rotation from the automatic group to individual nodes", () => {
    const config = buildMihomoConfig({ proxies: [
      { name: "node-a", type: "socks5", server: "one.test", port: 1080 },
      { name: "node-b", type: "socks5", server: "two.test", port: 1080 },
    ] });
    expect(config["external-controller"]).toBe("127.0.0.1:9090");
    expect(config.secret).toBe("");
    expect(config["proxy-groups"]).toEqual([
      {
        name: "JOJO-TIMES-AUTO",
        type: "url-test",
        proxies: ["node-a", "node-b"],
        url: "https://www.gstatic.com/generate_204",
        interval: 300,
        tolerance: 100,
      },
      {
        name: "JOJO-TIMES-ROUTE",
        type: "select",
        proxies: ["JOJO-TIMES-AUTO", "node-a", "node-b"],
      },
    ]);
    expect(config.rules).toEqual(["MATCH,JOJO-TIMES-ROUTE"]);
  });
});
