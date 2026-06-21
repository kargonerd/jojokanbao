import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Source } from '../entities/source.entity';
import { SourcesService } from '../services/sources.service';
import { SourcesController } from '../routes/sources.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Source])],
  providers: [SourcesService],
  controllers: [SourcesController],
  exports: [SourcesService]
})
export class SourcesModule {}
