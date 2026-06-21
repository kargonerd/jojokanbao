import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { News } from '../entities/news.entity';
import { NamedEntity } from '../entities/entity.entity';
import { ScrapbookItem } from '../entities/scrapbook-item.entity';
import { EntityExtractionService } from './entity-extraction.service';
import { ClaudeScrapbookService } from './claude-scrapbook.service';
import { SearchService } from './search.service';

@Injectable()
export class ScrapbookJobService {
  constructor(
    @InjectRepository(News) private readonly newsRepo: Repository<News>,
    @InjectRepository(NamedEntity) private readonly entityRepo: Repository<NamedEntity>,
    @InjectRepository(ScrapbookItem) private readonly scrapbookRepo: Repository<ScrapbookItem>,
    private readonly entityExtractor: EntityExtractionService,
    private readonly claudeService: ClaudeScrapbookService,
    private readonly searchService: SearchService
  ) {}

  async generateForNews(newsId: string) {
    const news = await this.newsRepo.findOne({ where: { id: newsId }, relations: ['entities'] });
    if (!news) return { created: 0 };

    const entities = news.entities?.length ? news.entities : await this.extractAndPersistEntities(news);
    const entityNames = entities.map((e) => e.name);

    let candidates = await this.newsRepo
      .createQueryBuilder('news')
      .leftJoin('news.entities', 'entity')
      .where('news.id != :id', { id: news.id })
      .andWhere('entity.name IN (:...names)', { names: entityNames.length ? entityNames : [''] })
      .orderBy('news.publishedAt', 'DESC')
      .limit(50)
      .getMany();

    // --- NEW: Real-time search fallback/enrichment ---
    // If we have very few candidates (e.g., cold start), we trigger a search
    if (candidates.length < 5 && entityNames.length > 0) {
       console.log(`[Scrapbook] Not enough local history for ${news.title}. Triggering web search...`);
       const query = `${entityNames.slice(0, 2).join(' ')} ${news.title.slice(0, 10)} 历史 承诺 计划`;
       const searchResults = await this.searchService.performSearch(query);
       
       for (const result of searchResults) {
          // Avoid duplicate local news and long scraping delays
          const exists = await this.newsRepo.findOne({ where: { url: result.url } });
          if (exists) {
            candidates.push(exists);
            continue;
          }

          // Scrape the content
          const content = await this.searchService.fetchArticleContent(result.url);
          if (content.length > 100) {
             // Save search result as a "Historical" news piece in our DB
             const newNews = this.newsRepo.create({
                title: `[Search] ${result.title}`, // Mark as search result
                summary: result.description,
                content: content,
                url: result.url,
                publishedAt: new Date(), // We might want to extract real date later
                // No source, it's ad-hoc
             });
             const saved = await this.newsRepo.save(newNews);
             candidates.push(saved);
          }
       }
    }
    // --------------------------------------------------

    const ranked = candidates
      .map((c) => ({
        news: c,
        score: this.rankCandidate(news, c, entityNames)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((c) => c.news);

    const suggestions = await this.claudeService.generate(
      { id: news.id, title: news.title, content: news.content },
      ranked.map((c) => ({ id: c.id, title: c.title, content: c.content }))
    );

    let created = 0;
    for (const s of suggestions) {
      const exists = await this.scrapbookRepo.findOne({
        where: { news: { id: news.id }, relatedNews: { id: s.relatedNewsId } }
      });
      if (exists) continue;

      const relatedNews = await this.newsRepo.findOne({ where: { id: s.relatedNewsId } });
      if (!relatedNews) continue;

      const item = this.scrapbookRepo.create({
        news,
        relatedNews,
        reason: s.reason,
        score: s.score
      });
      await this.scrapbookRepo.save(item);
      created += 1;
    }

    return { created };
  }

  private rankCandidate(base: News, candidate: News, entityNames: string[]) {
    const baseText = `${base.title} ${base.content}`;
    const candText = `${candidate.title} ${candidate.content}`;
    const overlap = entityNames.filter((n) => candText.includes(n)).length;
    const timeDiff = Math.abs(base.publishedAt.getTime() - candidate.publishedAt.getTime());
    const months = timeDiff / (1000 * 60 * 60 * 24 * 30);
    const contrastHints = ['反转', '打脸', '翻车', '改口', '转向', '不再', '改为'];
    const contrastScore = contrastHints.some((h) => baseText.includes(h) || candText.includes(h)) ? 0.2 : 0;
    return overlap * 1.2 + Math.min(months / 6, 1) + contrastScore;
  }

  private async extractAndPersistEntities(news: News) {
    const extracted = this.entityExtractor.extract(`${news.title} ${news.content}`);
    const entities: NamedEntity[] = [];

    for (const name of extracted) {
      let entity = await this.entityRepo.findOne({ where: { name } });
      if (!entity) {
        entity = this.entityRepo.create({ name, type: 'topic' });
        entity = await this.entityRepo.save(entity);
      }
      entities.push(entity);
    }

    news.entities = entities;
    await this.newsRepo.save(news);
    return entities;
  }
}
