import { Body, Controller, Post } from '@nestjs/common';
import { HighlightsService } from '../services/highlights.service';
import { CreateHighlightDto } from '../dto/create-highlight.dto';

@Controller('highlights')
export class HighlightsController {
  constructor(private readonly highlightsService: HighlightsService) {}

  @Post()
  async create(@Body() dto: CreateHighlightDto) {
    return this.highlightsService.create(dto);
  }
}
