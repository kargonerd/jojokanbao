export type JsonObject = Record<string, unknown>;

export type ProjectBlock = {
  id: string;
  type: string;
  text: string;
  sourcePage: number;
  bbox?: { x: number; y: number; width: number; height: number };
  level?: number;
};

export type ProjectDocument = {
  id: string;
  title: string;
  currentStage: string;
  createdAt: string;
  sourcePdf?: string;
  metadata: {
    subtitle: string | null;
    authors: string[];
    language: string;
    coverAssetId: string | null;
  };
  blocks: ProjectBlock[];
};

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character);
}

export function cleanBlocks(blocks: ProjectBlock[]) {
  return blocks.flatMap((block) => {
    const text = block.text.trim().replace(/\s+/g, ' ');
    const isPageMarker = /^[·.\s]*(?:[ivxlcdm]+|\d+)[·.\s]*$/i.test(text);
    const isWatermark = /(大众图书馆|dztsg\.info|dtssg\.info)/i.test(text);
    return block.type === 'page_number' || !text || isPageMarker || isWatermark
      ? []
      : [{ ...block, text }];
  });
}

export function buildProofreadIssues(blocks: ProjectBlock[]) {
  const hasLevel = /^(?:第\s*[一二三四五六七八九十百千零〇两\d]+\s*[章节回部篇卷集]|chapter\s+\d+)/i;
  return blocks.filter((block) => block.type === 'heading' && !hasLevel.test(block.text.trim())).map((block) => ({
    id: `issue-${block.id}`,
    kind: 'heading_level_review',
    severity: 'medium',
    blockId: block.id,
    message: '这个标题可能缺少章节层级，请核对。',
  }));
}

export function deepValue(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as JsonObject)[key];
  }
  return current;
}

export function firstString(...values: unknown[]) {
  const value = values.find(
    (candidate) => typeof candidate === 'string' && candidate.length > 0,
  );
  return typeof value === 'string' ? value : undefined;
}

export function normalizePage(item: JsonObject, pageOffset = 0) {
  const direct = Number(item.pageNum ?? item.page);
  if (Number.isInteger(direct) && direct >= 1) return direct + pageOffset;
  const index = Number(item.page_idx);
  return Number.isInteger(index) && index >= 0 ? index + 1 + pageOffset : 1 + pageOffset;
}

export function normalizeBbox(value: unknown) {
  if (Array.isArray(value) && value.length >= 4) {
    const [left, top, right, bottom] = value.map(Number);
    return {
      x: left,
      y: top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  }
  if (value && typeof value === 'object') {
    const box = value as JsonObject;
    return {
      x: Number(box.x ?? 0),
      y: Number(box.y ?? 0),
      width: Number(box.width ?? 0),
      height: Number(box.height ?? 0),
    };
  }
  return { x: 0, y: 0, width: 0, height: 0 };
}
