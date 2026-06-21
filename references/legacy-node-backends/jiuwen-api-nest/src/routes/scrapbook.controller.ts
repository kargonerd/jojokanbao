import { Controller, Get, Param } from '@nestjs/common';
import { ScrapbookService } from '../services/scrapbook.service';

@Controller('scrapbook')
export class ScrapbookController {
  constructor(private readonly scrapbookService: ScrapbookService) {}

  @Get(':newsId')
  async list(@Param('newsId') newsId: string) {
    return this.scrapbookService.listForNews(newsId);
  }
}
