/**
 * 实体抽取服务
 * 从 RSS 文章内容中抽取人名、机构、事件等实体
 */

import { generateText } from "ai"

export interface ExtractedEntity {
  name: string
  type: "person" | "organization" | "policy" | "event" | "concept" | "other"
  description: string
  confidence: number
  context: string
}

export interface EntityExtractionResult {
  success: boolean
  entities: ExtractedEntity[]
  error?: string
  processedAt: string
}

/**
 * 构建实体抽取 Prompt
 */
function buildExtractionPrompt(title: string, content: string): string {
  return `请分析以下新闻内容，抽取关键实体（人名、机构、政策、事件、概念等）。

【新闻标题】
${title}

【新闻内容】
${content.substring(0, 8000)}

【任务要求】
1. 识别新闻中提到的所有重要实体
2. 对每个实体，给出：
   - 实体名称
   - 实体类型（person/organization/policy/event/concept/other）
   - 一句话描述该实体在新闻中的角色
   - 置信度（0-100）
   - 上下文片段（实体在文章中出现的原文片段，50字以内）
3. 按重要性排序，最多返回10个实体
4. 只输出JSON数组，不要其他文字

【输出格式】
[
  {
    "name": "张雪峰",
    "type": "person",
    "description": "教育网红，因考研指导走红",
    "confidence": 95,
    "context": "张雪峰在直播中表示..."
  }
]`
}

/**
 * 从文章中抽取实体
 */
export async function extractEntitiesFromEntry(
  title: string,
  content: string,
  model: string = "gemini-1.5-flash"
): Promise<EntityExtractionResult> {
  try {
    const prompt = buildExtractionPrompt(title, content)

    const { text } = await generateText({
      model,
      prompt,
      temperature: 0.3,
      maxOutputTokens: 2000,
    })

    // 解析 JSON
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
      return {
        success: false,
        entities: [],
        error: "无法解析实体抽取结果",
        processedAt: new Date().toISOString(),
      }
    }

    const entities: ExtractedEntity[] = JSON.parse(jsonMatch[0])

    // 过滤低置信度的实体
    const filteredEntities = entities.filter((e) => e.confidence >= 70)

    return {
      success: true,
      entities: filteredEntities,
      processedAt: new Date().toISOString(),
    }
  } catch (error) {
    console.error("实体抽取失败:", error)
    return {
      success: false,
      entities: [],
      error: error instanceof Error ? error.message : String(error),
      processedAt: new Date().toISOString(),
    }
  }
}

/**
 * 批量抽取实体（用于历史文章）
 */
export async function batchExtractEntities(
  entries: Array<{ id: string; title: string; content: string }>,
  onProgress?: (current: number, total: number) => void
): Promise<Map<string, EntityExtractionResult>> {
  const results = new Map<string, EntityExtractionResult>()

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry) continue
    try {
      const result = await extractEntitiesFromEntry(entry.title, entry.content)
      results.set(entry.id, result)

      if (onProgress) {
        onProgress(i + 1, entries.length)
      }

      // 添加延迟避免限流
      if (i < entries.length - 1) {
        await sleep(1000)
      }
    } catch (error) {
      console.error(`抽取文章 ${entry.id} 失败:`, error)
    }
  }

  return results
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
