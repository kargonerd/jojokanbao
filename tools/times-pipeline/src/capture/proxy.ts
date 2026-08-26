function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function selectProxyCandidates(
  routeValue: unknown,
  automaticValue: unknown,
  proxiesValue: unknown,
  automaticName: string,
  maximum: number,
): string[] {
  const route = object(routeValue);
  const automatic = object(automaticValue);
  const proxies = object(proxiesValue);
  if (!Array.isArray(route.all)) throw new Error("The local Mihomo route group has no proxy candidates");
  const excluded = new Set([automaticName, route.now, automatic.now].filter((value): value is string => typeof value === "string"));
  const available = route.all.filter((value): value is string => typeof value === "string" && Boolean(value) && !excluded.has(value));
  const records = object(proxies.proxies);
  const delay = (name: string): number | undefined => {
    const row = object(records[name]);
    if (!Array.isArray(row.history)) return undefined;
    return row.history.map(object).map((entry) => entry.delay)
      .filter((value): value is number => Number.isInteger(value) && (value as number) > 0).at(-1);
  };
  const healthy = available.filter((name) => delay(name) !== undefined);
  const pool = healthy.length ? healthy : available;
  if (pool.length <= maximum) return pool;
  const selected = [...pool]
    .sort((left, right) => (delay(left) ?? Number.MAX_SAFE_INTEGER) - (delay(right) ?? Number.MAX_SAFE_INTEGER))
    .slice(0, Math.min(3, maximum));
  const remaining = maximum - selected.length;
  for (let index = 0; index < remaining; index += 1) {
    const position = Math.round((index + 1) * (pool.length - 1) / (remaining + 1));
    const candidate = pool[position];
    if (candidate && !selected.includes(candidate)) selected.push(candidate);
  }
  selected.push(...pool.filter((name) => !selected.includes(name)));
  return selected.slice(0, maximum);
}

async function mihomoJson(controlUrl: string, pathname: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(new URL(pathname, controlUrl), { ...init, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Mihomo control API returned HTTP ${response.status}`);
  const body = await response.text();
  return body ? JSON.parse(body) : undefined;
}

export async function proxyCandidates(controlUrl: string, group: string, automatic: string, maximum: number): Promise<string[]> {
  const [route, automaticRoute, proxies] = await Promise.all([
    mihomoJson(controlUrl, `/proxies/${encodeURIComponent(group)}`),
    mihomoJson(controlUrl, `/proxies/${encodeURIComponent(automatic)}`),
    mihomoJson(controlUrl, "/proxies"),
  ]);
  return selectProxyCandidates(route, automaticRoute, proxies, automatic, maximum);
}

export async function selectProxy(controlUrl: string, group: string, name: string): Promise<void> {
  await mihomoJson(controlUrl, `/proxies/${encodeURIComponent(group)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
}
