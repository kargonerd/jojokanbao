import { Body, Controller, Post } from '@nestjs/common';
import { ScrapbookJobService } from '../services/scrapbook-job.service';

@Controller('jobs')
export class ScrapbookJobsController {
  constructor(private readonly scrapbookJobs: ScrapbookJobService) {}

  @Post('generate-scrapbook')
  async generate(@Body() body: { newsId: string }) {
    return this.scrapbookJobs.generateForNews(body.newsId);
  }
}
