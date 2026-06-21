import type { ExtractedEntity, TimelineEvent } from './types.js'
import { spawn } from 'child_process'
import { promisify } from 'util'

// 使用 Claude Code CLI 进行 AI 分析
async function callClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // 直接使用 claude 命令，通过 echo 传递 prompt
    const isWindows = process.platform === 'win32'
    const shell = isWindows ? 'cmd' : 'bash'
    const shellFlag = isWindows ? '/c' : '-c'
    const command = isWindows 
      ? `echo ${JSON.stringify(prompt)} | claude --print`
      : `echo ${JSON.stringify(prompt)} | claude --print`
    
    const claude = spawn(shell, [shellFlag, command], {
      timeout: 120000, // 120秒超时
    })

    let output = ''
    let error = ''

    claude.stdout.on('data', (data) => {
      output += data.toString()
    })

    claude.stderr.on('data', (data) => {
      error += data.toString()
    })

    claude.on('close', (code) => {
      if (code !== 0) {
        console.error('[Claude] 错误:', error)
        reject(new Error(`Claude 进程退出码: ${code}, 错误: ${error}`))
      } else {
        resolve(output.trim())
      }
    })

    claude.on('error', (err) => {
      reject(new Error(`启动 Claude 失败: ${err.message}`))
    })
  })
}

// 实体抽取（使用 Claude Code）
export async function extractEntities(title: string, content: string): Promise<ExtractedEntity[]> {
  console.log('[AI] 使用 Claude 抽取实体:', title)

  const prompt = `分析以下新闻内容，提取关键实体（人物、组织、地点）。

新闻标题：${title}
新闻内容：${content}

请以 JSON 格式返回实体列表，格式如下：
{
  "entities": [
    {
      "name": "实体名称",
      "type": "person/organization/location",
      "description": "简短描述",
      "confidence": 85
    }
  ]
}

要求：
1. 只提取重要的、有新闻价值的实体
2. 人物类型用 "person"
3. 组织机构用 "organization"
4. 地点用 "location"
5. confidence 范围 0-100
6. 最多提取 10 个实体
7. 只返回 JSON，不要其他文字`

  try {
    const response = await callClaude(prompt)
    console.log('[Claude] 实体抽取响应:', response)

    // 提取 JSON 部分
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      throw new Error('无法解析 Claude 响应')
    }

    const data = JSON.parse(jsonMatch[0])
    const entities: ExtractedEntity[] = data.entities.map((e: any, index: number) => ({
      id: `entity_${index + 1}`,
      name: e.name,
      type: e.type,
      description: e.description,
      confidence: e.confidence,
      context: extractContext(content, e.name),
    }))

    console.log(`[AI] Claude 提取到 ${entities.length} 个实体`)
    return entities
  } catch (error) {
    console.error('[AI] Claude 实体抽取失败:', error)
    // 如果失败，返回空数组而不是 mock 数据
    return []
  }
}

// 时间线生成（使用 Claude Code）
export async function generateTimeline(entityName: string, entityType: string): Promise<TimelineEvent[]> {
  console.log('[AI] 使用 Claude 生成时间线:', entityName, entityType)

  const typeMap: Record<string, string> = {
    person: '人物',
    organization: '组织',
    location: '地点',
    policy: '政策',
    event: '事件',
    concept: '概念',
    other: '其他',
  }

  const prompt = `为以下实体生成相关事件时间线，并为每个事件生成相关的新闻来源链接。

实体名称：${entityName}
实体类型：${typeMap[entityType] || entityType}

请以 JSON 格式返回时间线事件列表，格式如下：
{
  "events": [
    {
      "date": "2026-03-01",
      "title": "事件标题",
      "description": "事件描述（2-3句话）",
      "sourceUrl": "https://example.com/news/123",
      "sourceTitle": "新闻来源名称"
    }
  ]
}

要求：
1. 生成 4-6 个与该实体相关的重要事件
2. 日期格式：YYYY-MM-DD，从过去到现在
3. 事件应该真实、有意义
4. sourceUrl 必须是一个真实的新闻链接（可以用 Google News 搜索链接格式：https://news.google.com/search?q=关键词）
5. sourceTitle 是新闻来源名称
6. 只返回 JSON，不要其他文字`

  try {
    const response = await callClaude(prompt)
    console.log('[Claude] 时间线生成响应:', response)

    // 提取 JSON 部分
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      throw new Error('无法解析 Claude 响应')
    }

    const data = JSON.parse(jsonMatch[0])
    const events: TimelineEvent[] = data.events.map((e: any, index: number) => ({
      id: `event_${index + 1}`,
      date: e.date,
      title: e.title,
      description: e.description,
      sourceUrl: e.sourceUrl,
      sourceTitle: e.sourceTitle,
    }))

    // 按日期排序
    events.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

    console.log(`[AI] Claude 生成 ${events.length} 个时间线事件`)
    return events
  } catch (error) {
    console.error('[AI] Claude 时间线生成失败:', error)
    // 如果失败，返回空数组而不是 mock 数据
    return []
  }
}

// 从文本中提取实体上下文
function extractContext(text: string, entityName: string): string | undefined {
  const index = text.indexOf(entityName)
  if (index === -1) return undefined

  const start = Math.max(0, index - 30)
  const end = Math.min(text.length, index + entityName.length + 30)
  return text.substring(start, end)
}
