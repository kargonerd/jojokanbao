import {
  JoxClient, asJojoFragment, asJojoItemManifest, bookFragmentAssetRefs, resolveJoxObject,
  type JojoFragment, type JojoItemManifest,
} from "@jojo/content";

export interface PreviewItem {
  client: JoxClient;
  manifest: JojoItemManifest;
  manifestObject: string;
}

export function previewClient(jobId: string): JoxClient {
  const base = new URL(`/api/content/jobs/${encodeURIComponent(jobId)}/preview/delivery/`, location.origin);
  return new JoxClient(base, (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
      throw new Error("预览只能读取本次导入的本地文件");
    }
    return fetch(url, { ...init, cache: "no-store" });
  });
}

export async function loadPreviewItem(client: JoxClient, manifestObject: string, signal: AbortSignal): Promise<PreviewItem> {
  const manifest = asJojoItemManifest(await client.fetchJson(manifestObject, signal));
  if (!manifest.content.chapters?.length) throw new Error("这本书没有可预览的章节");
  return { client, manifest, manifestObject };
}

export async function loadPreviewChapter(item: PreviewItem, chapterId: string, signal: AbortSignal) {
  const { client, manifest, manifestObject } = item;
  const chapter = manifest.content.chapters?.find((candidate) => candidate.id === chapterId);
  if (!chapter) throw new Error("找不到此章节");
  const fragment = asJojoFragment(await client.fetchJson<JojoFragment>(resolveJoxObject(manifestObject, chapter.object), signal));
  if (fragment.itemId !== manifest.itemId || fragment.fragmentId !== chapterId) throw new Error("章节内容不匹配");
  const coverId = manifest.assets.find((asset) => asset.role === "cover")?.id;
  const noteAssetIds = fragment.annotations.flatMap((note) => bookFragmentAssetRefs({ ...fragment, body: note.body, assetRefs: [] }));
  const assetIds = [...new Set([...bookFragmentAssetRefs(fragment), ...noteAssetIds, ...(coverId ? [coverId] : [])])];
  const assetUrls: Record<string, string> = {};
  const warnings: string[] = [];
  await Promise.all(assetIds.map(async (id) => {
    try {
      const asset = manifest.assets.find((candidate) => candidate.id === id);
      if (!asset) throw new Error("资源未导入");
      const bytes = await client.fetchDecodedBytes(resolveJoxObject(manifestObject, asset.object), signal);
      if (!signal.aborted) assetUrls[id] = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: asset.mediaType }));
    } catch {
      warnings.push(`图片未能加载：${id}。请检查导入说明和资源选项。`);
    }
  }));
  if (signal.aborted) {
    Object.values(assetUrls).forEach((url) => URL.revokeObjectURL(url));
    throw new Error("读取已取消");
  }
  return { fragment, assetUrls, warnings, coverId };
}

export type PreviewChapter = Awaited<ReturnType<typeof loadPreviewChapter>>;
