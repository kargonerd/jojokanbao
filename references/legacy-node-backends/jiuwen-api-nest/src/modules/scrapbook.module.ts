import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { News } from '../entities/news.entity';
import { NamedEntity } from '../entities/entity.entity';
import { ScrapbookItem } from '../entities/scrapbook-item.entity';
import { EntityExtractionService } from '../services/entity-extraction.service';
import { ClaudeScrapbookService } from '../services/claude-scrapbook.service';
import { ScrapbookJobService } from '../services/scrapbook-job.service';
import { ScrapbookService } from '../services/scrapbook.service';
import { ScrapbookController } from '../routes/scrapbook.controller';
import { ScrapbookJobsController } from '../routes/scrapbook-jobs.controller';
import { SearchService } from '../services/search.service';

@Module({
  imports: [TypeOrmModule.forFeature([News, NamedEntity, ScrapbookItem])],
  controllers: [ScrapbookController, ScrapbookJobsController],
  providers: [EntityExtractionService, ClaudeScrapbookService, ScrapbookJobService, ScrapbookService, SearchService],
  exports: [ScrapbookJobService]
})
export class ScrapbookModule {}
