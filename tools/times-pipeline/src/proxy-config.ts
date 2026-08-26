import { parse, stringify } from "yaml";

interface ProxyNode {
  name: string;
  [key: string]: unknown;
}

export interface ProxySubscription {
  proxies: ProxyNode[];
}

export function parseProxySubscription(value: string): ProxySubscription {
  let parsed: unknown;
  try {
    parsed = parse(value);
  } catch {
    throw new Error("The configured proxy subscription is not valid Clash YAML");
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { proxies?: unknown }).proxies)) {
    throw new Error("The configured proxy subscription does not contain a proxies list");
  }
  const proxies: ProxyNode[] = [];
  const seen = new Set<string>();
  for (const value of (parsed as { proxies: unknown[] }).proxies) {
    if (!value || typeof value !== "object") continue;
    const node = value as Record<string, unknown>;
    if (typeof node.name !== "string" || !node.name || seen.has(node.name)) continue;
    seen.add(node.name);
    proxies.push(node as ProxyNode);
  }
  if (proxies.length === 0) throw new Error("The configured proxy subscription contains no usable nodes");
  return { proxies };
}

export function buildMihomoConfig(subscription: ProxySubscription): Record<string, unknown> {
  const names = [...new Set(subscription.proxies.map((node) => node.name))];
  const autoGroup = "JOJO-TIMES-AUTO";
  const routeGroup = "JOJO-TIMES-ROUTE";
  if (names.includes(autoGroup) || names.includes(routeGroup)) {
    throw new Error("The proxy subscription contains a reserved JOJO group name");
  }
  return {
    "mixed-port": 7890,
    "allow-lan": false,
    "bind-address": "127.0.0.1",
    mode: "rule",
    "log-level": "warning",
    "external-controller": "127.0.0.1:9090",
    secret: "",
    "unified-delay": true,
    "tcp-concurrent": true,
    proxies: subscription.proxies,
    "proxy-groups": [
      {
        name: autoGroup,
        type: "url-test",
        proxies: names,
        url: "https://www.gstatic.com/generate_204",
        interval: 300,
        tolerance: 100,
      },
      {
        name: routeGroup,
        type: "select",
        proxies: [autoGroup, ...names],
      },
    ],
    rules: [`MATCH,${routeGroup}`],
  };
}

export function serializeMihomoConfig(subscription: ProxySubscription): string {
  return stringify(buildMihomoConfig(subscription), { lineWidth: 0 });
}
