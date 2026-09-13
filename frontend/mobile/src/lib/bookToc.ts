import type { JojoChapterDescriptor, JojoTocNode } from "@jojo/content";

export interface BookTocEntry {
  id: string;
  title: string;
  chapterId?: string;
  anchorId?: string;
  depth: number;
}

export function bookTocEntries(toc: readonly JojoTocNode[], chapters: readonly JojoChapterDescriptor[]): BookTocEntry[] {
  const available = new Set(chapters.map((chapter) => chapter.id));
  const entries: BookTocEntry[] = [];
  function visit(nodes: readonly JojoTocNode[], depth: number, inheritedChapter?: string) {
    for (const node of nodes) {
      const chapterId = node.targetId && available.has(node.targetId) ? node.targetId : inheritedChapter;
      entries.push({ id: node.id, title: node.title, chapterId, anchorId: node.anchorId, depth });
      visit(node.children ?? [], depth + 1, chapterId);
    }
  }
  visit(toc, 0);
  // Keep older manifests readable without inventing hierarchy from chapter names.
  const represented = new Set(entries.map((entry) => entry.chapterId));
  for (const chapter of chapters) {
    if (!represented.has(chapter.id)) entries.push({ id: `chapter:${chapter.id}`, title: chapter.title, chapterId: chapter.id, depth: 0 });
  }
  return entries;
}
