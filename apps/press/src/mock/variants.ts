export type MockVariantId = 'a' | 'b' | 'c';

export type MockVariantDefinition = {
  id: MockVariantId;
  shortLabel: string;
  title: string;
  description: string;
  themeClassName: string;
};

export const DEFAULT_MOCK_VARIANT: MockVariantId = 'a';

export const MOCK_VARIANTS: MockVariantDefinition[] = [
  {
    id: 'a',
    shortLabel: '版本 A',
    title: '出版编辑版',
    description: '平衡的出版工作台，适合总览任务和推进流程。',
    themeClassName: 'mock-variant--a'
  },
  {
    id: 'b',
    shortLabel: '版本 B',
    title: '革命文献版',
    description: '克制的暗红与旧纸质感，像在整理一册年代文献。',
    themeClassName: 'mock-variant--b'
  },
  {
    id: 'c',
    shortLabel: '版本 C',
    title: 'OCR 校对版',
    description: '更密集、更像生产工具，强调问题与状态。',
    themeClassName: 'mock-variant--c'
  }
];

export function isMockVariantId(value: string | null | undefined): value is MockVariantId {
  return value === 'a' || value === 'b' || value === 'c';
}

export function resolveMockVariant(value: string | null | undefined): MockVariantId {
  return isMockVariantId(value) ? value : DEFAULT_MOCK_VARIANT;
}

export function getMockVariantDefinition(variant: MockVariantId) {
  return MOCK_VARIANTS.find((item) => item.id === variant) ?? MOCK_VARIANTS[0];
}
