import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { News } from '../src/entities/news.entity';
import { Source } from '../src/entities/source.entity';
import { NewsService } from '../src/services/news.service';
import { ScrapbookItem } from '../src/entities/scrapbook-item.entity';
import { Highlight } from '../src/entities/highlight.entity';
import { Comment } from '../src/entities/comment.entity';
import { NamedEntity } from '../src/entities/entity.entity';

jest.setTimeout(30000);

describe('NewsService', () => {
  it('can list news', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          dropSchema: true,
          entities: [News, Source, NamedEntity, ScrapbookItem, Highlight, Comment],
          synchronize: true
        }),
        TypeOrmModule.forFeature([News, Source, ScrapbookItem, Highlight, Comment])
      ],
      providers: [NewsService]
    }).compile();

    const service = moduleRef.get(NewsService);
    const list = await service.list();
    expect(Array.isArray(list)).toBe(true);
  });
});
