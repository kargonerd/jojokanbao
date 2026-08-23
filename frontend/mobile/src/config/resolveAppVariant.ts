export type AppVariant = "standard" | "eink";

export function resolveAppVariant(value: string | undefined): AppVariant {
  return value?.trim().toLowerCase() === "eink" ? "eink" : "standard";
}
