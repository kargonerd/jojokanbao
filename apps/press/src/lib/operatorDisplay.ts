const STAGE_LABELS: Record<string, string> = {
  'Metadata confirmation': '确认书籍信息',
  'Proofreading workspace': '文字校对'
};

const EXPORT_LABELS: Record<string, string> = {
  'Export Markdown': '导出 Markdown',
  'Export HTML': '导出 HTML',
  'Export EPUB': '导出 EPUB',
  'Export jojo-rag Package': '导出 jojo-rag 包'
};

const ENGINE_STATUS_LABELS: Record<string, string> = {
  ok: '正常',
  offline: '离线'
};

export function isProofreadStage(stage: string) {
  return stage === 'Proofreading workspace';
}

export function getStageLabel(stage: string) {
  return STAGE_LABELS[stage] ?? stage;
}

export function getProjectEntryActionLabel(stage: string) {
  return isProofreadStage(stage) ? '继续处理' : '进入处理';
}

export function getExportOptionLabel(label: string) {
  return EXPORT_LABELS[label] ?? label;
}

export function getEngineStatusLabel(status: string) {
  return ENGINE_STATUS_LABELS[status] ?? status;
}
