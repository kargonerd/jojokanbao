import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Comment } from '../entities/comment.entity';
import { Highlight } from '../entities/highlight.entity';
import { CreateCommentDto } from '../dto/create-comment.dto';

@Injectable()
export class CommentsService {
  constructor(
    @InjectRepository(Comment) private readonly commentRepo: Repository<Comment>,
    @InjectRepository(Highlight) private readonly highlightRepo: Repository<Highlight>
  ) {}

  async create(dto: CreateCommentDto) {
    const highlight = await this.highlightRepo.findOne({ where: { id: dto.highlightId } });
    if (!highlight) return null;

    const comment = this.commentRepo.create({
      highlight,
      userId: dto.userId,
      displayName: dto.displayName || null,
      content: dto.content
    });
    return this.commentRepo.save(comment);
  }
}
