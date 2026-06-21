import { IsString, IsUrl } from 'class-validator';

export class CreateSourceDto {
  @IsString()
  name!: string;

  @IsUrl()
  rssUrl!: string;
}
