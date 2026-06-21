import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as Parser from 'rss-parser';
import { Source } from '../entities/source.entity';
import { News } from '../entities/news.entity';

@Injectable()
export class RssService {
  private parser = new Parser();

  constructor(
    @InjectRepository(Source) private readonly sourceRepo: Repository<Source>,
    @InjectRepository(News) private readonly newsRepo: Repository<News>
  ) {}

  async fetchAllSources() {
    const sources = await this.sourceRepo.find();
    const results = [] as { sourceId: string; count: number }[];
    for (const source of sources) {
      const count = await this.fetchSource(source);
      results.push({ sourceId: source.id, count });
    }
    return results;
  }

  async fetchSource(source: Source) {
    const feed = await this.parser.parseURL(source.rssUrl);
    let created = 0;

    for (const item of feed.items) {
      if (!item.link || !item.title || !item.pubDate) continue;
      const exists = await this.newsRepo.findOne({ where: { url: item.link } });
      if (exists) continue;

      const news = this.newsRepo.create({
        title: item.title,
        summary: item.contentSnippet || null,
        content: item.content || item.contentSnippet || item.title,
        url: item.link,
        publishedAt: new Date(item.pubDate),
        source
      });
      await this.newsRepo.save(news);
      created += 1;
    }

    source.lastFetchedAt = new Date();
    await this.sourceRepo.save(source);

    return created;
  }
}
