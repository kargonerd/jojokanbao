function uniqueNonEmpty(values: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value?.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

function explicitPool(value: string | undefined): string[] {
  return uniqueNonEmpty(value?.split(/[\s,;]+/u) ?? []);
}

export function geminiApiKeysFromEnvironment(environment: NodeJS.ProcessEnv = process.env): string[] {
  const configuredPool = explicitPool(environment.GEMINI_API_KEYS);
  if (configuredPool.length > 0) return configuredPool;

  const numbered = Object.entries(environment)
    .flatMap(([name, value]) => {
      const match = /^GEMINI_API_KEY_(\d+)$/u.exec(name);
      return match ? [{ order: Number(match[1]), value }] : [];
    })
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.value);
  return uniqueNonEmpty([environment.GEMINI_API_KEY, ...numbered]);
}

export function normalizeGeminiApiKeys(apiKeys: readonly string[] | undefined, legacyApiKey?: string): string[] {
  return uniqueNonEmpty([...(apiKeys ?? []), legacyApiKey]);
}
