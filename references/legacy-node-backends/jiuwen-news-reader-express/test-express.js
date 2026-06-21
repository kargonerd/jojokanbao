import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/news', async (req, res) => {
  console.log('[API] 收到新闻请求');
  try {
    // 模拟数据
    const news = [
      {
        id: 'test_1',
        title: '测试新闻',
        content: '这是测试内容',
        summary: '这是测试摘要...',
        link: 'https://example.com',
        pubDate: new Date().toISOString(),
        sourceId: 'test',
        sourceName: '测试源',
      }
    ];
    console.log('[API] 返回模拟数据');
    res.json(news);
  } catch (error) {
    console.error('[API] 错误:', error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = 4567;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
