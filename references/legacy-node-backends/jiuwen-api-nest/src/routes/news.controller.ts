import { Controller, Get, Param } from '@nestjs/common';
import { NewsService } from '../services/news.service';

@Controller('news')
export class NewsController {
  constructor(private readonly newsService: NewsService) {}

  @Get()
  async list() {
    return this.newsService.list();
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    return this.newsService.getDetail(id);
  }
}
