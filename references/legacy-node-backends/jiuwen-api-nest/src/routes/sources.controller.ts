import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { SourcesService } from '../services/sources.service';
import { CreateSourceDto } from '../dto/create-source.dto';

@Controller('sources')
export class SourcesController {
  constructor(private readonly sourcesService: SourcesService) {}

  @Get()
  async list() {
    return this.sourcesService.list();
  }

  @Post()
  async create(@Body() dto: CreateSourceDto) {
    return this.sourcesService.create(dto);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.sourcesService.remove(id);
  }
}
