import { IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreateHighlightDto {
  @IsUUID()
  newsId!: string;

  @IsString()
  userId!: string;

  @IsOptional()
  @IsString()
  displayName?: string;

  @IsInt()
  @Min(0)
  startOffset!: number;

  @IsInt()
  @Min(0)
  endOffset!: number;

  @IsString()
  text!: string;
}
