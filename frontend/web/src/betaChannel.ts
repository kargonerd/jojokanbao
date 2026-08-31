export const BETA_HOSTNAME = "beta.jojokanbao.cn";

export function isBetaHostname(hostname: string): boolean {
  return hostname.trim().toLowerCase() === BETA_HOSTNAME;
}

export function isBetaRelease(hostname: string, releaseChannel?: string): boolean {
  return releaseChannel?.trim().toLowerCase() === "beta" || isBetaHostname(hostname);
}

export function isBetaChannel(): boolean {
  return typeof window !== "undefined"
    && isBetaRelease(window.location.hostname, import.meta.env.VITE_RELEASE_CHANNEL);
}

export function applyBetaMetadata(
  documentRoot: Document = document,
  hostname = window.location.hostname,
  releaseChannel = import.meta.env.VITE_RELEASE_CHANNEL,
): boolean {
  if (!isBetaRelease(hostname, releaseChannel)) return false;

  let robots = documentRoot.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
  if (!robots) {
    robots = documentRoot.createElement("meta");
    robots.name = "robots";
    documentRoot.head.append(robots);
  }
  robots.content = "noindex,nofollow,noarchive";
  documentRoot.documentElement.dataset.releaseChannel = "beta";
  return true;
}
