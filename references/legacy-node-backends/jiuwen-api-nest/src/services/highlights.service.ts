import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Highlight } from '../entities/highlight.entity';
import { News } from '../entities/news.entity';
import { CreateHighlightDto } from '../dto/create-highlight.dto';

@Injectable()
export class HighlightsService {
  constructor(
    @InjectRepository(Highlight) private readonly highlightRepo: Repository<Highlight>,
    @InjectRepository(News) private readonly newsRepo: Repository<News>
  ) {}

  async create(dto: CreateHighlightDto) {
    const news = await this.newsRepo.findOne({ where: { id: dto.newsId } });
    if (!news) return null;

    const highlight = this.highlightRepo.create({
      news,
      userId: dto.userId,
      displayName: dto.displayName || null,
      startOffset: dto.startOffset,
      endOffset: dto.endOffset,
      text: dto.text
    });
    return this.highlightRepo.save(highlight);
  }
}
