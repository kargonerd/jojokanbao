import { IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateCommentDto {
  @IsUUID()
  highlightId!: string;

  @IsString()
  userId!: string;

  @IsOptional()
  @IsString()
  displayName?: string;

  @IsString()
  content!: string;
}
