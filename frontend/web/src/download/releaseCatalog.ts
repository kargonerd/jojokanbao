export type ReleaseChannel = "stable";
export type ReleaseProduct = "desktop" | "mobile";
export type ReleasePlatform = "windows" | "macos" | "linux" | "android";

export interface ReleaseArtifact {
  id: string;
  platform: ReleasePlatform;
  arch: string;
  format: string;
  label: string;
  url: string;
  size: number;
  sha256: string;
  minimumOs?: string;
}

export interface ReleaseCatalog {
  schemaVersion: 1;
  product: ReleaseProduct;
  variant?: "standard" | "eink";
  channel: ReleaseChannel;
  version: string;
  buildNumber?: number;
  publishedAt: string;
  releaseNotesUrl: string;
  sourceUrl: string;
  mandatory?: boolean;
  minimumVersion?: string | null;
  artifacts: ReleaseArtifact[];
}

const productPaths = ["desktop", "mobile/android", "mobile/android-eink"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isArtifact(value: unknown): value is ReleaseArtifact {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && ["windows", "macos", "linux", "android"].includes(String(value.platform))
    && typeof value.arch === "string"
    && typeof value.format === "string"
    && typeof value.label === "string"
    && isHttpsUrl(value.url)
    && Number.isFinite(value.size)
    && typeof value.sha256 === "string"
    && /^[a-f\d]{64}$/i.test(value.sha256);
}

export function parseReleaseCatalog(value: unknown): ReleaseCatalog | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined;
  if (value.product !== "desktop" && value.product !== "mobile") return undefined;
  if (value.variant !== undefined && value.variant !== "standard" && value.variant !== "eink") return undefined;
  if (value.channel !== "stable") return undefined;
  if (typeof value.version !== "string" || !value.version.trim()) return undefined;
  if (typeof value.publishedAt !== "string" || !Number.isFinite(Date.parse(value.publishedAt))) return undefined;
  if (!isHttpsUrl(value.releaseNotesUrl) || !isHttpsUrl(value.sourceUrl)) return undefined;
  if (!Array.isArray(value.artifacts) || !value.artifacts.every(isArtifact)) return undefined;
  return value as unknown as ReleaseCatalog;
}

export function releaseCatalogUrls(baseUrl: string): string[] {
  const root = baseUrl.replace(/\/+$/, "");
  return productPaths.map((product) => `${root}/${product}/stable/catalog.json`);
}

export function formatReleaseSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "大小未知";
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

export function recommendedArtifact(
  catalogs: ReleaseCatalog[],
  platform: ReleasePlatform,
  arch?: string,
): ReleaseArtifact | undefined {
  const candidates = catalogs.flatMap((catalog) => catalog.artifacts);
  const platformCandidates = candidates.filter((artifact) => artifact.platform === platform);
  if (platform === "android") {
    return platformCandidates.find((artifact) => artifact.id === "android-standard") ?? platformCandidates[0];
  }
  const architectureCandidates = arch
    ? platformCandidates.filter((artifact) => artifact.arch === arch)
    : platformCandidates;
  if (platform === "linux") {
    return architectureCandidates.find((artifact) => artifact.format.toLowerCase() === "appimage")
      ?? architectureCandidates[0];
  }
  return architectureCandidates[0];
}

export function detectedPlatform(userAgent: string): { platform?: ReleasePlatform; arch?: string } {
  const agent = userAgent.toLowerCase();
  if (agent.includes("android")) return { platform: "android", arch: "universal" };
  if (agent.includes("windows")) return { platform: "windows", arch: agent.includes("arm64") ? "arm64" : "x64" };
  if (agent.includes("macintosh") || agent.includes("mac os")) return { platform: "macos" };
  if (agent.includes("linux")) return { platform: "linux", arch: agent.includes("aarch64") ? "arm64" : "x64" };
  return {};
}
