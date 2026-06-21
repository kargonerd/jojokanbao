import { Controller, Post } from '@nestjs/common';
import { RssService } from '../services/rss.service';

@Controller('jobs')
export class JobsController {
  constructor(private readonly rssService: RssService) {}

  @Post('fetch-rss')
  async fetchRss() {
    return this.rssService.fetchAllSources();
  }
}
