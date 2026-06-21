import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Source } from '../entities/source.entity';
import { CreateSourceDto } from '../dto/create-source.dto';

@Injectable()
export class SourcesService {
  constructor(@InjectRepository(Source) private readonly sourceRepo: Repository<Source>) {}

  async list(): Promise<Source[]> {
    return this.sourceRepo.find({ order: { createdAt: 'DESC' } });
  }

  async create(dto: CreateSourceDto) {
    const source = this.sourceRepo.create(dto);
    return this.sourceRepo.save(source);
  }

  async remove(id: string) {
    const source = await this.sourceRepo.findOne({ where: { id } });
    if (!source) return null;
    await this.sourceRepo.remove(source);
    return { id };
  }
}
