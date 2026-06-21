import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Comment } from '../entities/comment.entity';
import { CommentsService } from '../services/comments.service';
import { CommentsController } from '../routes/comments.controller';
import { Highlight } from '../entities/highlight.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Comment, Highlight])],
  providers: [CommentsService],
  controllers: [CommentsController]
})
export class CommentsModule {}
