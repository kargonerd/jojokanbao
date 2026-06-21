import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';

type ScrapbookSuggestion = {
  relatedNewsId: string;
  reason: string;
  score: number;
};

@Injectable()
export class ClaudeScrapbookService {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });
  }

  async generate(news: { id: string; title: string; content: string }, candidates: { id: string; title: string; content: string }[]) {
    if (!process.env.ANTHROPIC_API_KEY) return [];
    const prompt = {
      model: 'claude-3-7-sonnet-20250219',
      max_tokens: 800,
      messages: [
        {
          role: 'user' as const,
          content: `请从候选新闻中挑选最多3条，与当前新闻形成“合订本”（前后反差/观点演变/历史对照）。\n\n当前新闻：${news.title}\n${news.content.slice(0, 1200)}\n\n候选新闻（id|title|content）：\n${candidates
            .map((c) => `${c.id}|${c.title}|${c.content.slice(0, 500)}`)
            .join('\n')}\n\n请输出 JSON 数组，每项包含 relatedNewsId, reason, score(0-1)。只输出 JSON。`
        }
      ]
    };

    const resp = await this.client.messages.create(prompt);
    const text = resp.content?.[0]?.type === 'text' ? resp.content[0].text : '';
    try {
      const parsed = JSON.parse(text) as ScrapbookSuggestion[];
      return parsed.filter((p) => p.relatedNewsId && p.reason);
    } catch {
      return [];
    }
  }
}
