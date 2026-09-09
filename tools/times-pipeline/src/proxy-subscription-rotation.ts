/** Stable slots keep each provider's encrypted cache and refresh clock separate. */
export function selectProxySubscription(options: {
  primary: string;
  secondary?: string | undefined;
  runNumber?: string | undefined;
  rotationOffset?: string | undefined;
}): { url: string; slot: 0 | 1; count: number; rotationOffset: number } {
  const urls = [...new Set([options.primary.trim(), options.secondary?.trim()].filter((url): url is string => !!url))];
  if (!options.primary.trim()) throw new Error("Primary proxy subscription is not configured");
  const runNumber = Number(options.runNumber ?? "1");
  const rotationOffset = Number(options.rotationOffset ?? "0");
  if (!Number.isSafeInteger(runNumber) || runNumber < 1) throw new Error("Invalid proxy rotation run number");
  if (!Number.isSafeInteger(rotationOffset) || rotationOffset < 0 || rotationOffset >= urls.length) {
    throw new Error("Invalid proxy rotation offset");
  }
  // A rerun keeps the same preferred provider; successive workflow runs alternate.
  const slot = ((runNumber - 1 + rotationOffset) % urls.length) as 0 | 1;
  try {
    if (!["https:", "http:"].includes(new URL(urls[slot]!).protocol)) throw new Error();
  } catch { throw new Error("Proxy subscription URL is invalid"); }
  return { url: urls[slot]!, slot, count: urls.length, rotationOffset };
}
