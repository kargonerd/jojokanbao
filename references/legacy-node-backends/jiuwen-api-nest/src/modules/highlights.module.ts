import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Highlight } from '../entities/highlight.entity';
import { HighlightsService } from '../services/highlights.service';
import { HighlightsController } from '../routes/highlights.controller';
import { News } from '../entities/news.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Highlight, News])],
  providers: [HighlightsService],
  controllers: [HighlightsController]
})
export class HighlightsModule {}
