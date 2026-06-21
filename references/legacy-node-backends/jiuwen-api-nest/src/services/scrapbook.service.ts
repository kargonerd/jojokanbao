import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ScrapbookItem } from '../entities/scrapbook-item.entity';
import { News } from '../entities/news.entity';

@Injectable()
export class ScrapbookService {
  constructor(
    @InjectRepository(ScrapbookItem) private readonly scrapbookRepo: Repository<ScrapbookItem>,
    @InjectRepository(News) private readonly newsRepo: Repository<News>
  ) {}

  async listForNews(newsId: string) {
    return this.scrapbookRepo.find({
      where: { news: { id: newsId } },
      relations: ['relatedNews'],
      order: { score: 'DESC' }
    });
  }

  async create(newsId: string, relatedNewsId: string, reason: string, score: number) {
    const news = await this.newsRepo.findOne({ where: { id: newsId } });
    const relatedNews = await this.newsRepo.findOne({ where: { id: relatedNewsId } });
    if (!news || !relatedNews) return null;

    const item = this.scrapbookRepo.create({
      news,
      relatedNews,
      reason,
      score
    });

    return this.scrapbookRepo.save(item);
  }
}
