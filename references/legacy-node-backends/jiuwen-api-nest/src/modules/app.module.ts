import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { NewsModule } from './news.module';
import { SourcesModule } from './sources.module';
import { HighlightsModule } from './highlights.module';
import { CommentsModule } from './comments.module';
import { ScrapbookModule } from './scrapbook.module';
import { RssModule } from './rss.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot({
      type: 'sqlite',
      database: 'dev.sqlite',
      autoLoadEntities: true,
      synchronize: true
    }),
    ScheduleModule.forRoot(),
    NewsModule,
    SourcesModule,
    HighlightsModule,
    CommentsModule,
    ScrapbookModule,
    RssModule
  ]
})
export class AppModule {}
