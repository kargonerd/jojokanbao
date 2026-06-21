import { XMLParser } from 'fast-xml-parser'
import type { NewsItem, RSSSource } from './types.js'

// RSSHub 基础 URL
const RSSHUB_BASE = 'https://rsshub-latest-5elh.onrender.com'

// 默认RSS源配置 - 按分类组织
export const DEFAULT_SOURCES: RSSSource[] = [
  // ===== 中文媒体 =====
  {
    id: 'zaobao-china',
    name: '联合早报 - 中国',
    url: `${RSSHUB_BASE}/zaobao/znews/china`,
    category: '中文',
    description: '新加坡联合早报中国新闻',
    icon: '🇸🇬',
    country: '新加坡',
  },
  {
    id: 'zaobao-world',
    name: '联合早报 - 国际',
    url: `${RSSHUB_BASE}/zaobao/znews/world`,
    category: '中文',
    description: '新加坡联合早报国际新闻',
    icon: '🇸🇬',
    country: '新加坡',
  },
  {
    id: 'zaobao-seasia',
    name: '联合早报 - 东南亚',
    url: `${RSSHUB_BASE}/zaobao/znews/seasia`,
    category: '中文',
    description: '新加坡联合早报东南亚新闻',
    icon: '🇸🇬',
    country: '新加坡',
  },
  {
    id: 'zaobao-uschina',
    name: '联合早报 - 美中',
    url: `${RSSHUB_BASE}/zaobao/znews/uschina`,
    category: '中文',
    description: '新加坡联合早报美中新闻',
    icon: '🇸',
    country: '新加坡',
  },
  {
    id: 'infzm',
    name: '南方周末 - 头条',
    url: `${RSSHUB_BASE}/infzm/news`,
    category: '中文',
    description: '南方周末新闻头条',
    icon: '📰',
    country: '中国',
  },
  {
    id: 'caixin',
    name: '财新 - 最新文章',
    url: `${RSSHUB_BASE}/caixin/latest`,
    category: '中文',
    description: '财新最新文章',
    icon: '💰',
    country: '中国',
  },
  {
    id: 'thepaper',
    name: '澎湃新闻',
    url: `${RSSHUB_BASE}/thepaper/featured`,
    category: '中文',
    description: '澎湃新闻精选',
    icon: '🌊',
    country: '中国',
  },
  {
    id: 'jike-topic',
    name: '即刻 - 主题',
    url: `${RSSHUB_BASE}/jike/topic/square`,
    category: '中文',
    description: '即刻主题广场',
    icon: '⚡',
    country: '中国',
  },

  // ===== 国际媒体 =====
  {
    id: 'bbc-chinese',
    name: 'BBC 中文网',
    url: `${RSSHUB_BASE}/bbc/chinese`,
    category: '国际',
    description: 'BBC 中文新闻',
    icon: '🇬🇧',
    country: '英国',
  },
  {
    id: 'cna-chinese',
    name: '新加坡 CNA',
    url: `${RSSHUB_BASE}/cna/chinese/latest`,
    category: '国际',
    description: '新加坡亚洲新闻台中文',
    icon: '🇸🇬',
    country: '新加坡',
  },
  {
    id: 'reuters-chinese',
    name: '路透社 - 中文',
    url: `${RSSHUB_BASE}/reuters/daily-news`,
    category: '国际',
    description: '路透社新闻',
    icon: '📡',
    country: '国际',
  },
  {
    id: 'nytimes',
    name: '纽约时报',
    url: `${RSSHUB_BASE}/nytimes/morning_post`,
    category: '国际',
    description: '纽约时报新闻',
    icon: '🗽',
    country: '美国',
  },
  {
    id: 'aljazeera-cn',
    name: '半岛电视台 - 中文',
    url: `${RSSHUB_BASE}/aljazeera/news`,
    category: '国际',
    description: '半岛电视台新闻',
    icon: '🏜️',
    country: '卡塔尔',
  },
  {
    id: 'hk01',
    name: '香港 01',
    url: `${RSSHUB_BASE}/hk01/channel/0`,
    category: '国际',
    description: '香港 01 新闻',
    icon: '🇭🇰',
    country: '香港',
  },
  {
    id: 'rfi',
    name: '法国国际广播电台',
    url: `${RSSHUB_BASE}/rfi/news`,
    category: '国际',
    description: '法国国际广播电台新闻',
    icon: '🇫🇷',
    country: '法国',
  },
  {
    id: 'dw-chinese',
    name: '德国之声 - 中文',
    url: `${RSSHUB_BASE}/dw/news/zh`,
    category: '国际',
    description: '德国之声中文新闻',
    icon: '🇩🇪',
    country: '德国',
  },

  // ===== 科技媒体 =====
  {
    id: '36kr',
    name: '36氪',
    url: `${RSSHUB_BASE}/36kr/newsflashes`,
    category: '科技',
    description: '36氪快讯',
    icon: '',
    country: '中国',
  },
  {
    id: 'hackernews',
    name: 'Hacker News',
    url: `${RSSHUB_BASE}/hackernews/best`,
    category: '科技',
    description: 'Hacker News 最佳文章',
    icon: '👾',
    country: '美国',
  },
  {
    id: 'techcrunch',
    name: 'TechCrunch',
    url: `${RSSHUB_BASE}/techcrunch/news`,
    category: '科技',
    description: 'TechCrunch 科技新闻',
    icon: '💻',
    country: '美国',
  },
  {
    id: 'wired',
    name: 'Wired',
    url: `${RSSHUB_BASE}/wired/news`,
    category: '科技',
    description: 'Wired 科技杂志',
    icon: '🔌',
    country: '美国',
  },

  // ===== 财经媒体 =====
  {
    id: 'yicai',
    name: '第一财经',
    url: `${RSSHUB_BASE}/yicai/brief`,
    category: '财经',
    description: '第一财经快讯',
    icon: '📊',
    country: '中国',
  },
  {
    id: 'jinshi',
    name: '金十数据',
    url: `${RSSHUB_BASE}/jinshi`,
    category: '财经',
    description: '金十数据快讯',
    icon: '💹',
    country: '中国',
  },
]

// 模拟新闻数据（当 RSS 抓取失败时的后备数据）
const MOCK_NEWS: NewsItem[] = [
  {
    id: 'zaobao-china_1',
    title: '习近平会见西班牙首相桑切斯',
    content: '中国国家主席习近平星期二（4月14日）会见正式访华的西班牙首相桑切斯，强调当今世界乱象丛生，面临公理和强权的较量。他呼吁中国和西班牙加强沟通、巩固互信、紧密合作，反对世界倒退回丛林法则，共同捍卫多边主义，维护国际秩序。',
    summary: '中国国家主席习近平星期二（4月14日）会见正式访华的西班牙首相桑切斯，强调当今世界乱象丛生...',
    link: 'https://www.zaobao.com/news/china/story20260414-8890571',
    pubDate: '2026-04-14T06:15:53.000Z',
    sourceId: 'zaobao-china',
    sourceName: '联合早报 - 中国',
    icon: '🇸🇬',
  },
  {
    id: 'bbc-chinese_1',
    title: '美伊紧张局势升级 特朗普下令海军拦截并攻击教皇',
    content: '美国总统特朗普宣布对伊朗采取更强硬措施，下令海军在霍尔木兹海峡实施更严格的海上封锁并拦截船只。全球市场对危机加剧作出强烈反应，油价应声上涨。',
    summary: '美国总统特朗普宣布对伊朗采取更强硬措施，下令海军在霍尔木兹海峡实施更严格的海上封锁...',
    link: 'https://www.bbc.com/zhongwen',
    pubDate: '2026-04-14T05:00:00.000Z',
    sourceId: 'bbc-chinese',
    sourceName: 'BBC 中文网',
    icon: '🇬🇧',
  },
]

// 更完整的 HTML 实体解码函数
const decodeHtmlEntities = (text: string | undefined | null): string => {
  if (!text || typeof text !== 'string') return ''
  
  const entities: Record<string, string> = {
    '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'",
    '&#39;': "'", '&#x27;': "'", '&#x2F;': '/', '&#47;': '/',
    '&nbsp;': ' ', '&ensp;': ' ', '&emsp;': ' ', '&thinsp;': ' ',
    '&mdash;': '—', '&ndash;': '–', '&horbar;': '―',
    '&hellip;': '…', '&mldr;': '…',
    '&ldquo;': '"', '&rdquo;': '"',
    '&lsquo;': '\u2018', '&rsquo;': '\u2019',
    '&laquo;': '«', '&raquo;': '»', '&lsaquo;': '‹', '&rsaquo;': '›',
    '&copy;': '©', '&reg;': '®', '&trade;': '™',
    '&euro;': '€', '&pound;': '£', '&yen;': '¥', '&cent;': '¢',
    '&sect;': '§', '&para;': '¶', '&dagger;': '†', '&Dagger;': '‡',
    '&bull;': '•', '&middot;': '·', '&cdot;': '·',
    '&deg;': '°', '&prime;': '′', '&Prime;': '″',
    '&times;': '×', '&divide;': '÷',
    '&plusmn;': '±', '&frac14;': '¼', '&frac12;': '½', '&frac34;': '¾',
    '&sup1;': '¹', '&sup2;': '²', '&sup3;': '³',
    '&frac13;': '⅓', '&frac23;': '⅔', '&frac15;': '⅕', '&frac25;': '⅖',
    '&frac35;': '⅗', '&frac45;': '⅘', '&frac16;': '⅙', '&frac56;': '⅚',
    '&frac18;': '⅛', '&frac38;': '⅜', '&frac58;': '⅝', '&frac78;': '⅞',
    '&larr;': '←', '&uarr;': '↑', '&rarr;': '→', '&darr;': '↓',
    '&harr;': '↔', '&crarr;': '↵', '&lArr;': '⇐', '&uArr;': '⇑',
    '&rArr;': '⇒', '&dArr;': '⇓', '&hArr;': '⇔',
    '&forall;': '∀', '&part;': '∂', '&exist;': '∃', '&empty;': '∅',
    '&nabla;': '∇', '&isin;': '∈', '&notin;': '∉', '&ni;': '∋',
    '&prod;': '∏', '&sum;': '∑', '&lowast;': '∗',
    '&radic;': '√', '&prop;': '∝', '&infin;': '∞', '&ang;': '∠',
    '&and;': '∧', '&or;': '∨', '&cap;': '∩', '&cup;': '∪',
    '&int;': '∫', '&there4;': '∴', '&sim;': '∼', '&cong;': '≅',
    '&asymp;': '≈', '&ne;': '≠', '&equiv;': '≡', '&le;': '≤', '&ge;': '≥',
    '&sub;': '⊂', '&sup;': '⊃', '&nsub;': '⊄', '&sube;': '⊆', '&supe;': '⊇',
    '&oplus;': '⊕', '&otimes;': '⊗', '&perp;': '⊥', '&sdot;': '⋅',
    '&lceil;': '⌈', '&rceil;': '⌉', '&lfloor;': '⌊', '&rfloor;': '⌋',
    '&lang;': '⟨', '&rang;': '⟩', '&loz;': '◊', '&spades;': '♠',
    '&clubs;': '♣', '&hearts;': '♥', '&diams;': '♦',
  }
  
  // 处理数字实体 (如 &#123; 或 &#x7B;)
  let decoded = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
  decoded = decoded.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
  
  // 处理命名实体
  decoded = decoded.replace(/&[a-zA-Z][a-zA-Z0-9]*;/g, (entity) => entities[entity] || entity)
  
  return decoded
}

// 解析 RSS XML
export async function parseRSS(xml: string, source: RSSSource): Promise<NewsItem[]> {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    processEntities: true,
    htmlEntities: true,
  })
  
  const result = parser.parse(xml)
  const channel = result.rss?.channel || result.feed
  const items = channel?.item || channel?.entry || []
  const itemArray = Array.isArray(items) ? items : [items].filter(Boolean)
  
  return itemArray.map((item: any, index: number) => {
    const content = item['content:encoded'] || 
                   item.description || 
                   item.content || 
                   item.summary || 
                   ''
    
    // 清理 HTML 标签并解码实体
    let plainContent = content.replace(/<[^>]*>/g, '').trim()
    plainContent = decodeHtmlEntities(plainContent)
    
    // 处理标题中的实体
    let title = item.title || '无标题'
    title = decodeHtmlEntities(title)
    
    return {
      id: `${source.id}_${index}_${Date.now()}`,
      title: title,
      content: plainContent,
      summary: plainContent.slice(0, 200) + (plainContent.length > 200 ? '...' : ''),
      link: item.link?.href || item.link || '',
      pubDate: item.pubDate || item.published || item.updated || new Date().toISOString(),
      sourceId: source.id,
      sourceName: source.name,
      icon: source.icon,
      category: source.category,
      imageUrl: extractImageUrl(content, item),
    }
  })
}

// 提取图片 URL
function extractImageUrl(content: string, item: any): string | undefined {
  const imgMatch = content.match(/<img[^>]+src=["']([^"']+)["']/i)
  if (imgMatch) {
    return imgMatch[1]
  }
  
  if (item['media:content']?.['@_url']) {
    return item['media:content']['@_url']
  }
  
  if (item.enclosure?.['@_url']) {
    return item.enclosure['@_url']
  }
  
  return undefined
}

// 获取 RSS 新闻（真实 RSS 抓取）
export async function fetchRSSNews(source: RSSSource): Promise<NewsItem[]> {
  try {
    console.log(`[RSS] 开始获取: ${source.name} - ${source.url}`)
    
    const response = await fetch(source.url, {
      headers: {
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    })
    
    console.log(`[RSS] 响应状态: ${response.status}`)
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }
    
    const xml = await response.text()
    console.log(`[RSS] 获取到 XML 长度: ${xml.length}`)
    
    if (xml.length === 0) {
      throw new Error('Empty response')
    }
    
    const news = await parseRSS(xml, source)
    console.log(`[RSS] 解析到 ${news.length} 条新闻`)
    
    return news
  } catch (error) {
    console.error(`[RSS] 获取失败 [${source.name}]:`, error)
    return []
  }
}

// 获取所有源的新闻
export async function fetchAllNews(sourceIds?: string[]): Promise<NewsItem[]> {
  console.log('[RSS] 获取新闻')
  
  const sourcesToFetch = sourceIds
    ? DEFAULT_SOURCES.filter(s => sourceIds.includes(s.id))
    : DEFAULT_SOURCES
  
  const allNews: NewsItem[] = []
  
  for (const source of sourcesToFetch) {
    try {
      const news = await fetchRSSNews(source)
      allNews.push(...news)
    } catch (error) {
      console.warn(`跳过失败的源: ${source.name}`)
    }
  }
  
  // 按发布时间排序
  return allNews.sort((a, b) => 
    new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime()
  )
}

// 初始化时预加载新闻
export async function preloadNews(): Promise<void> {
  console.log('[RSS] 预加载新闻完成（使用模拟数据）')
}
