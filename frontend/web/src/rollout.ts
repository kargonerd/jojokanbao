function enabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export const rollout = {
  // Local development always runs the current platform. Production keeps one
  // coarse rollback switch for the whole redesigned Web runtime.
  platformRedesign: import.meta.env.DEV || enabled(import.meta.env.VITE_ENABLE_PLATFORM_REDESIGN),
} as const;
