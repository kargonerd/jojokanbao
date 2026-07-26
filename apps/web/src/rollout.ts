function enabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export const rollout = {
  account: enabled(import.meta.env.VITE_ENABLE_ACCOUNT),
  olds: enabled(import.meta.env.VITE_ENABLE_OLDS),
  rag: enabled(import.meta.env.VITE_ENABLE_RAG),
} as const;
