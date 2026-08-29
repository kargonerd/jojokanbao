import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CapturedAsset } from "../types.js";
import type { PageImageCandidate } from "./page-images.js";

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
  const images = [...new Map(options.images.map((image) => [image.sourceUrl, image])).values()];
  const downloaded = new Array<{ image: PageImageCandidate; result: { body: Buffer; mediaType: string } } | undefined>(images.length);
  let cursor = 0;
  const consume = async (): Promise<void> => {
    while (cursor < images.length) {
      const index = cursor++;
      const image = images[index]!;
      const result = await options.download(image.sourceUrl, options.pageUrl);
      if (result?.mediaType.startsWith("image/")) downloaded[index] = { image, result };
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, images.length) }, consume));
  const assets = new Map<string, CapturedAsset>();
  for (const entry of downloaded) {
    if (!entry) continue;
    const { image, result } = entry;
    const sha256 = createHash("sha256").update(result.body).digest("hex");
    const suffix = extension(result.mediaType, image.sourceUrl);
    const objectName = `raw/${options.sourceId}/assets/${sha256}.${suffix}`;
    const target = path.join(options.workspace, ...objectName.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, result.body);
    const id = `asset:${sha256}`;
    const previous = assets.get(id);
    assets.set(id, {
      id,
      type: "image",
      role: previous?.role === "lead" ? "lead" : image.role,
      sourceUrl: image.sourceUrl,
      rawObject: objectName,
      mediaType: result.mediaType,
      size: result.body.byteLength,
      sha256,
      ...(image.alt ? { alt: image.alt } : {}),
      ...(image.caption ? { caption: image.caption } : {}),
      ...(image.credit ? { credit: image.credit } : {}),
      ...(image.width ? { width: image.width } : {}),
      ...(image.height ? { height: image.height } : {}),
      ...(image.afterBlock !== undefined ? { afterBlock: image.afterBlock } : {}),
    });
  }
  return [...assets.values()];
}
