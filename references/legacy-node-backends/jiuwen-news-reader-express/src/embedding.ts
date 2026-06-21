// 嵌入模型配置
const EMBEDDING_CONFIG = {
  // 向量维度 - bge-m3 是 1024 维
  dimension: parseInt(process.env.EMBEDDING_DIMENSION || '1024'),
  // API 配置
  apiUrl: process.env.EMBEDDING_API_URL || 'https://api.edgefn.net/v1/embeddings',
  apiKey: process.env.EMBEDDING_API_KEY || '',
  model: process.env.EMBEDDING_MODEL || 'BAAI/bge-m3',
}

// 生成文本嵌入向量
export async function generateEmbedding(text: string): Promise<number[]> {
  // 优先使用 API 生成 embedding
  if (EMBEDDING_CONFIG.apiKey) {
    return generateEmbeddingWithAPI(text)
  }
  
  // 降级：使用本地简化方案
  return generateEmbeddingWithHash(text)
}

// 使用 edgefn API 生成 embedding
async function generateEmbeddingWithAPI(text: string): Promise<number[]> {
  const response = await fetch(EMBEDDING_CONFIG.apiUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${EMBEDDING_CONFIG.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_CONFIG.model,
      input: text.slice(0, 8000), // 限制输入长度
    }),
  })
  
  if (!response.ok) {
    const error = await response.text()
    console.error('Embedding API error:', response.status, error)
    // API 失败时降级到本地方案
    return generateEmbeddingWithHash(text)
  }
  
  const data = await response.json()
  
  // 处理不同 API 返回格式
  if (data.data && data.data[0] && data.data[0].embedding) {
    return data.data[0].embedding
  }
  
  if (data.embedding) {
    return data.embedding
  }
  
  if (Array.isArray(data)) {
    return data
  }
  
  console.error('Unexpected embedding API response format:', data)
  return generateEmbeddingWithHash(text)
}

// 使用 hash 生成简化 embedding（降级方案）
async function generateEmbeddingWithHash(text: string): Promise<number[]> {
  const words = extractKeywords(text)
  const vector = new Array(EMBEDDING_CONFIG.dimension).fill(0)
  
  for (const word of words) {
    const hash = simpleHash(word) % EMBEDDING_CONFIG.dimension
    vector[hash] += 1
  }
  
  // 归一化
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
  if (magnitude > 0) {
    return vector.map(v => v / magnitude)
  }
  
  return vector
}

// 提取关键词
function extractKeywords(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  
  const words: string[] = []
  
  for (let i = 0; i < cleaned.length - 1; i++) {
    for (let len = 2; len <= 4 && i + len <= cleaned.length; len++) {
      const word = cleaned.slice(i, i + len)
      if (/^[\u4e00-\u9fa5]+$/.test(word) || /^[a-z]{4,}$/.test(word)) {
        words.push(word)
      }
    }
  }
  
  return words
}

// 简单的字符串 hash
function simpleHash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash)
}

// 计算余弦相似度
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have same dimension')
  }
  
  let dotProduct = 0
  let normA = 0
  let normB = 0
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  
  if (normA === 0 || normB === 0) return 0
  
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

// 批量生成嵌入
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  // 如果配置了 API，逐个调用（API 通常不支持批量）
  if (EMBEDDING_CONFIG.apiKey) {
    const results: number[][] = []
    for (const text of texts) {
      try {
        const embedding = await generateEmbeddingWithAPI(text)
        results.push(embedding)
      } catch (error) {
        console.error('Failed to generate embedding for text:', text.slice(0, 50))
        results.push(await generateEmbeddingWithHash(text))
      }
    }
    return results
  }
  
  // 本地方案可以并行
  return Promise.all(texts.map(text => generateEmbeddingWithHash(text)))
}
