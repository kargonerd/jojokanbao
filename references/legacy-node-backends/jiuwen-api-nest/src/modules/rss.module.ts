import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Source } from '../entities/source.entity';
import { News } from '../entities/news.entity';
import { RssService } from '../services/rss.service';
import { JobsController } from '../routes/jobs.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Source, News])],
  providers: [RssService],
  controllers: [JobsController],
  exports: [RssService]
})
export class RssModule {}
