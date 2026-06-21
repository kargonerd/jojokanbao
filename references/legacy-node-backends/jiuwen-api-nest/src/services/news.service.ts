import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { News } from '../entities/news.entity';
import { ScrapbookItem } from '../entities/scrapbook-item.entity';
import { Highlight } from '../entities/highlight.entity';
import { Comment } from '../entities/comment.entity';

@Injectable()
export class NewsService {
  constructor(
    @InjectRepository(News) private readonly newsRepo: Repository<News>,
    @InjectRepository(ScrapbookItem) private readonly scrapbookRepo: Repository<ScrapbookItem>,
    @InjectRepository(Highlight) private readonly highlightRepo: Repository<Highlight>,
    @InjectRepository(Comment) private readonly commentRepo: Repository<Comment>
  ) {}

  async list(): Promise<News[]> {
    return this.newsRepo.find({
      relations: ['source'],
      order: { publishedAt: 'DESC' }
    });
  }

  async getDetail(id: string) {
    const news = await this.newsRepo.findOne({
      where: { id },
      relations: ['source', 'entities']
    });
    if (!news) return null;

    const scrapbookItems = await this.scrapbookRepo.find({
      where: { news: { id } },
      relations: ['relatedNews']
    });

    const highlights = await this.highlightRepo.find({
      where: { news: { id } },
      order: { createdAt: 'DESC' }
    });

    const highlightIds = highlights.map((h) => h.id);
    const comments = highlightIds.length
      ? await this.commentRepo.find({
          where: highlightIds.map((hid) => ({ highlight: { id: hid } })),
          relations: ['highlight'],
          order: { createdAt: 'DESC' }
        })
      : [];

    return { news, scrapbookItems, highlights, comments };
  }
}
