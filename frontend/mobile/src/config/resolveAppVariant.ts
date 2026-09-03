export type AppVariant = "standard" | "eink";

export function resolveAppVariant(value: string | undefined): AppVariant {
  return value?.trim().toLowerCase() === "eink" ? "eink" : "standard";
}

export function resolveRuntimeAppVariant({
  platform,
  applicationId,
  explicitVariant,
}: {
  platform: string;
  applicationId: string | null;
  explicitVariant: string | undefined;
}): AppVariant {
  if (platform === "web") return resolveAppVariant(explicitVariant);
  if (applicationId) return applicationId.endsWith(".eink") ? "eink" : "standard";
  return resolveAppVariant(explicitVariant);
}
