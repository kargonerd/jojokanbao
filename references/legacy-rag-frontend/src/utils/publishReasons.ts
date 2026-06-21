const reasonLabels: Record<string, string> = {
  missing_title: '缺少标题',
  missing_description: '缺少描述',
  missing_cover: '缺少封面',
  missing_sources: '没有 source',
  incomplete_sources: '存在未完成配置的 source',
  missing_document: '缺少文档',
  document_not_ready: '文档状态未就绪',
}

export function formatPublishReasons(reasons?: string[]) {
  return (reasons || []).map(item => reasonLabels[item] || item).join('、')
}
