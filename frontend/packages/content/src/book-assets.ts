import type { JojoFragment } from "./types";

/** Include placeholders even when an older publisher omitted them from assetRefs. */
export function bookFragmentAssetRefs(fragment: JojoFragment): string[] {
  const refs = new Set(fragment.assetRefs);
  if (fragment.body.format === "html") {
    for (const match of fragment.body.value.matchAll(/\bdata-asset-id\s*=\s*(["'])(.*?)\1/gi)) {
      if (match[2]) refs.add(match[2]);
    }
  }
  return [...refs];
}
