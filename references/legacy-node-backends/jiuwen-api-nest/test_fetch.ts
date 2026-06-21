import * as cheerio from 'cheerio';
import Anthropic from '@anthropic-ai/sdk';

async function testFetch() {
  const url = 'https://cn.nytimes.com/science/20260402/moon-nasa-artemis-launch/';
  console.log('Fetching NYT article:', url);
  let currentArticleText = '';
  try {
      const response = await fetch(url);
      const html = await response.text();
      const $ = cheerio.load(html);
      
      // NYT Chinese uses div.article-paragraph for actual content
      $('.article-paragraph').each((i, el) => { 
          currentArticleText += $(el).text() + '\n'; 
      });
      
      if (!currentArticleText) {
         // Fallback if structure changes
         $('p').each((i, el) => { currentArticleText += $(el).text() + '\n'; });
      }
      
      console.log('--- Current Article Snippet ---');
      console.log(currentArticleText.trim().slice(0, 300) + '...');
  } catch (e) {
      console.error('Fetch error:', e);
      return;
  }

  // Simulated Historical Data (Since DuckDuckGo API wrapper is flaky in this ad-hoc env, 
  // we simulate the search results we would normally get from a robust search provider like SearXNG/Tavily)
  const simulatedHistoricalResults = [
     {
        title: "NASA delays Artemis moon missions, cite safety concerns - 2024",
        content: "NASA announced today it will delay its Artemis II and III missions. Artemis II, a crewed flyby of the moon, is moving from 2024 to September 2025. Artemis III, which will land astronauts on the moon, is moving from 2025 to September 2026. Administrator Bill Nelson cited safety of the crew as the primary reason."
     },
     {
        title: "SpaceX Starship delays push NASA moon landing to 2027? - 2025",
        content: "Industry experts predict NASA's Artemis III mission will slip again, likely to 2027, due to ongoing delays in the development of SpaceX's Starship Human Landing System and Axiom Space's spacesuits. The GAO previously warned the ambitious timeline was highly unlikely to be met."
     }
  ];

  console.log('\n--- Sending to Claude for Timeline Extraction ---');
  if (!process.env.ANTHROPIC_API_KEY) {
      console.log('ANTHROPIC_API_KEY not found. Skipping Claude test.');
      return;
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = {
      model: 'claude-3-7-sonnet-20250219',
      max_tokens: 1000,
      messages: [
        {
          role: 'user' as const,
          content: `你是一个资深新闻编辑。请阅读当前的最新新闻以及我提供的历史背景资料。
          请根据这些资料，梳理出该事件的**历史发展时间线 (Timeline)**，重点突出关键节点的演变、反转或延期情况。
          
          【当前最新新闻】
          标题：NASA Artemis 登月任务（模拟）
          正文：${currentArticleText.slice(0, 1500)}

          【历史背景资料】
          ${simulatedHistoricalResults.map(r => `标题: ${r.title}\n摘要: ${r.content}`).join('\n\n')}
          
          请直接输出一份有理有据的时间线梳理，指出态度的变化或承诺的落空。`
        }
      ]
  };

  try {
     const resp = await client.messages.create(prompt);
     console.log((resp.content[0] as any).text);
  } catch (e) {
     console.error('Claude error:', e);
  }
}

testFetch();
