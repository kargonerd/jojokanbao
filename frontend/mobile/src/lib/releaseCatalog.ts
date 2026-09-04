export interface NativeReleaseArtifact {
  id: string;
  platform: "android";
  arch: string;
  format: "apk";
  label: string;
  url: string;
  size: number;
  sha256: string;
}

export interface NativeReleaseCatalog {
  schemaVersion: 1;
  product: "mobile";
  variant: "standard" | "eink";
  channel: "stable";
  version: string;
  buildNumber: number;
  publishedAt: string;
  notes?: string;
  mandatory: boolean;
  minimumVersion: string | null;
  artifacts: NativeReleaseArtifact[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseNativeReleaseCatalog(value: unknown): NativeReleaseCatalog | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.product !== "mobile") return undefined;
  if (value.variant !== "standard" && value.variant !== "eink") return undefined;
  if (value.channel !== "stable") return undefined;
  if (typeof value.version !== "string" || !Number.isInteger(value.buildNumber) || Number(value.buildNumber) < 1) return undefined;
  if (typeof value.publishedAt !== "string" || typeof value.mandatory !== "boolean") return undefined;
  if (value.notes !== undefined && typeof value.notes !== "string") return undefined;
  if (value.minimumVersion !== null && typeof value.minimumVersion !== "string") return undefined;
  if (!Array.isArray(value.artifacts) || !value.artifacts.length) return undefined;
  const artifacts = value.artifacts.filter((artifact): artifact is NativeReleaseArtifact =>
    isRecord(artifact)
      && artifact.platform === "android"
      && artifact.format === "apk"
      && typeof artifact.id === "string"
      && typeof artifact.arch === "string"
      && typeof artifact.label === "string"
      && typeof artifact.url === "string"
      && Number.isInteger(artifact.size)
      && Number(artifact.size) > 0
      && typeof artifact.sha256 === "string"
      && /^[a-f\d]{64}$/i.test(artifact.sha256),
  );
  if (!artifacts.length) return undefined;
  return { ...value, artifacts } as unknown as NativeReleaseCatalog;
}

export function isNativeUpdateAvailable(installedBuild: string | null | undefined, catalog: NativeReleaseCatalog): boolean {
  const current = Number.parseInt(installedBuild || "0", 10);
  return Number.isFinite(current) && catalog.buildNumber > current;
}
