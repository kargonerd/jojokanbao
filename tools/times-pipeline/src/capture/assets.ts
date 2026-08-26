import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CapturedAsset } from "../types.js";
import type { PageImageCandidate } from "./article-content.js";

function extension(mediaType: string, sourceUrl: string): string {
  const byType: Record<string, string> = {
    "image/avif": "avif",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/svg+xml": "svg",
    "image/webp": "webp",
  };
  if (byType[mediaType]) return byType[mediaType]!;
  try {
    const suffix = path.posix.extname(new URL(sourceUrl).pathname).slice(1).toLowerCase();
    if (/^(?:avif|gif|jpe?g|png|svg|webp)$/u.test(suffix)) return suffix === "jpeg" ? "jpg" : suffix;
  } catch {
    // Fall through to a neutral binary suffix.
  }
  return "bin";
}

export async function captureArticleAssets(options: {
  workspace: string;
  sourceId: string;
  pageUrl: string;
  images: readonly PageImageCandidate[];
  download: (url: string, referer: string) => Promise<{ body: Buffer; mediaType: string } | undefined>;
}): Promise<CapturedAsset[]> {
  const assets = new Map<string, CapturedAsset>();
  for (const image of options.images) {
    const downloaded = await options.download(image.sourceUrl, options.pageUrl);
    if (!downloaded || !downloaded.mediaType.startsWith("image/")) continue;
    const sha256 = createHash("sha256").update(downloaded.body).digest("hex");
    const suffix = extension(downloaded.mediaType, image.sourceUrl);
    const objectName = `raw/${options.sourceId}/assets/${sha256}.${suffix}`;
    const target = path.join(options.workspace, ...objectName.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, downloaded.body);
    const id = `asset:${sha256}`;
    const previous = assets.get(id);
    assets.set(id, {
      id,
      type: "image",
      role: previous?.role === "lead" ? "lead" : image.role,
      sourceUrl: image.sourceUrl,
      rawObject: objectName,
      mediaType: downloaded.mediaType,
      size: downloaded.body.byteLength,
      sha256,
      ...(image.alt ? { alt: image.alt } : {}),
      ...(image.caption ? { caption: image.caption } : {}),
      ...(image.width ? { width: image.width } : {}),
      ...(image.height ? { height: image.height } : {}),
    });
  }
  return [...assets.values()];
}
