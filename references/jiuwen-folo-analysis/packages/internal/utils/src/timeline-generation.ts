/**
 * 时间线生成服务
 * 为实体生成历史时间线
 */

import { generateText } from "ai"

export interface TimelineEvent {
  date: string
  title: string
  description: string
  sourceUrl: string
  sourceTitle: string
}

export interface TimelineGenerationResult {
  success: boolean
  events: TimelineEvent[]
  error?: string
  searchQueries: string[]
  generatedAt: string
}

/**
 * 构建时间线生成 Prompt
 */
function buildTimelinePrompt(entityName: string, entityType: string, searchResults: string): string {
  return `你是一个严谨的新闻编辑。请基于提供的搜索结果，为"${entityName}"生成完整的历史时间线。

【实体信息】
名称: ${entityName}
类型: ${entityType}

【搜索结果】
${searchResults}

【任务要求】
1. 从搜索结果中提取所有与该实体相关的时间节点
2. 每个时间节点包含：
   - date: 日期（格式：YYYY-MM-DD，如果只有年月用 YYYY-MM）
   - title: 事件标题（简洁，20字以内）
   - description: 事件描述（详细，100字以内）
   - sourceUrl: 来源链接（从搜索结果中复制）
   - sourceTitle: 来源标题
3. 按时间顺序排列（从早到晚）
4. 只使用搜索结果中明确提到的事实，严禁编造
5. 如果搜索结果信息不足，返回空数组
6. 只输出JSON数组，不要其他文字

【输出格式】
[
  {
    "date": "2021-05-13",
    "title": "苏州峰学蔚来成立",
    "description": "张雪峰宣布离开北京迁往苏州，成立峰学蔚来教育科技公司",
    "sourceUrl": "https://...",
    "sourceTitle": "某新闻报道"
  }
]`
}

/**
 * 生成实体的时间线
 */
export async function generateTimeline(
  entityName: string,
  entityType: string,
  searchResults: string,
  model: string = "gemini-1.5-flash"
): Promise<TimelineGenerationResult> {
  try {
    const prompt = buildTimelinePrompt(entityName, entityType, searchResults)

    const { text } = await generateText({
      model,
      prompt,
      temperature: 0.2,
      maxOutputTokens: 4000,
    })

    // 解析 JSON
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
      return {
        success: false,
        events: [],
        error: "无法解析时间线生成结果",
        searchQueries: [],
        generatedAt: new Date().toISOString(),
      }
    }

    const events: TimelineEvent[] = JSON.parse(jsonMatch[0])

    return {
      success: true,
      events,
      searchQueries: [], // 可以从调用处传入
      generatedAt: new Date().toISOString(),
    }
  } catch (error) {
    console.error("时间线生成失败:", error)
    return {
      success: false,
      events: [],
      error: error instanceof Error ? error.message : String(error),
      searchQueries: [],
      generatedAt: new Date().toISOString(),
    }
  }
}

/**
 * 验证链接有效性
 */
export async function validateLinks(events: TimelineEvent[]): Promise<{
  valid: TimelineEvent[]
  invalid: TimelineEvent[]
}> {
  const valid: TimelineEvent[] = []
  const invalid: TimelineEvent[] = []

  for (const event of events) {
    try {
      const response = await fetch(event.sourceUrl, {
        method: "HEAD",
        signal: AbortSignal.timeout(5000),
      })

      if (response.ok) {
        valid.push(event)
      } else {
        invalid.push(event)
      }
    } catch {
      invalid.push(event)
    }
  }

  return { valid, invalid }
}

/**
 * 生成时间线 HTML
 */
export function generateTimelineHTML(entityName: string, events: TimelineEvent[]): string {
  if (events.length === 0) {
    return `<div class="timeline-empty">暂无时间线数据</div>`
  }

  const items = events
    .map(
      (event) => `
    <div class="timeline-item">
      <div class="timeline-marker"></div>
      <div class="timeline-content">
        <time class="timeline-date">${event.date}</time>
        <h3 class="timeline-title">${event.title}</h3>
        <p class="timeline-description">${event.description}</p>
        <a href="${event.sourceUrl}" target="_blank" rel="noopener noreferrer" class="timeline-source">
          来源: ${event.sourceTitle || "查看原文"}
        </a>
      </div>
    </div>
  `
    )
    .join("")

  return `
<div class="timeline-container">
  <h2 class="timeline-header">${entityName} - 历史时间线</h2>
  <div class="timeline">
    ${items}
  </div>
  <div class="timeline-footer">
    共 ${events.length} 个事件
  </div>
</div>
`
}
