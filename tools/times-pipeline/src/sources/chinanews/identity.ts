/** China News exposes the same dated manuscript under several news sections. */
export function chinanewsDeliveryIdentity(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port
    || !["www.chinanews.com.cn", "chinanews.com.cn"].includes(url.hostname)) return undefined;
  const match = url.pathname.match(/^\/(?:gn|cj|gj|sh)\/(\d{4})\/(\d{2}-\d{2})\/(\d+)\.shtml$/u);
  if (!match) return undefined;
  const date = `${match[1]}-${match[2]}`;
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) return undefined;
  return `${date}/${match[3]}`;
}
