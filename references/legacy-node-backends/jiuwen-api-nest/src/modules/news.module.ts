import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { News } from '../entities/news.entity';
import { Source } from '../entities/source.entity';
import { ScrapbookItem } from '../entities/scrapbook-item.entity';
import { Highlight } from '../entities/highlight.entity';
import { Comment } from '../entities/comment.entity';
import { NewsService } from '../services/news.service';
import { NewsController } from '../routes/news.controller';

@Module({
  imports: [TypeOrmModule.forFeature([News, Source, ScrapbookItem, Highlight, Comment])],
  providers: [NewsService],
  controllers: [NewsController],
  exports: [NewsService]
})
export class NewsModule {}
