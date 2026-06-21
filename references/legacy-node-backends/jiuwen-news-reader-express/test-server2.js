import express from 'express';
import cors from 'cors';
import { XMLParser } from 'fast-xml-parser';

const app = express();
app.use(cors());

const DEFAULT_SOURCES = [
  {
    id: 'zaobao-china',
    name: '联合早报 - 中国新闻',
    url: 'https://rsshub.pseudoyu.com/zaobao/znews/china',
    category: '中国',
    description: '新加坡联合早报中国新闻版块',
    icon: '🇨🇳',
  },
];

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/news', async (req, res) => {
  console.log('[API] 收到新闻请求');
  try {
    const source = DEFAULT_SOURCES[0];
    console.log('[RSS] 开始获取:', source.name);

    // 添加超时处理
    const fetchPromise = fetch(source.url, {
      headers: {
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Fetch timeout')), 10000);
    });

    const response = await Promise.race([fetchPromise, timeoutPromise]);
    console.log('[RSS] 响应状态:', response.status);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const xml = await response.text();
    console.log('[RSS] XML 长度:', xml.length);

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      processEntities: false,
      htmlEntities: false,
    });

    const result = parser.parse(xml);
    const channel = result.rss?.channel || result.feed;
    const items = channel?.item || channel?.entry || [];
    const itemArray = Array.isArray(items) ? items : [items].filter(Boolean);

    console.log('[RSS] 解析到条目数:', itemArray.length);

    const news = itemArray.map((item, index) => {
      const content = item['content:encoded'] || item.description || item.content || item.summary || '';
      const plainContent = content.replace(/<[^>]*>/g, '').trim();

      return {
        id: `${source.id}_${index}_${Date.now()}`,
        title: item.title || '无标题',
        content: plainContent,
        summary: plainContent.slice(0, 200) + (plainContent.length > 200 ? '...' : ''),
        link: item.link?.href || item.link || '',
        pubDate: item.pubDate || item.published || item.updated || new Date().toISOString(),
        sourceId: source.id,
        sourceName: source.name,
      };
    });

    console.log('[API] 返回新闻数:', news.length);
    res.json(news);
  } catch (error) {
    console.error('[API] 错误:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 全局错误处理
process.on('uncaughtException', (err) => {
  console.error('未捕获的异常:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的 Promise 拒绝:', reason);
});

const PORT = 4567;
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
