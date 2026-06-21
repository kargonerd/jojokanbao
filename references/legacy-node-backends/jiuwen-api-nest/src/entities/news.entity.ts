import { Column, CreateDateColumn, Entity, Index, ManyToMany, ManyToOne, PrimaryGeneratedColumn, JoinTable } from 'typeorm';
import { Source } from './source.entity';
import { NamedEntity } from './entity.entity';

@Entity('news')
export class News {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  @Index()
  title!: string;

  @Column({ type: 'text', nullable: true })
  summary?: string | null;

  @Column({ type: 'text' })
  content!: string;

  @Column()
  url!: string;

  @Column({ type: 'datetime' })
  publishedAt!: Date;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @ManyToOne(() => Source, (source) => source.news)
  source!: Source;

  @ManyToMany(() => NamedEntity, (entity) => entity.news)
  @JoinTable({ name: 'news_entities' })
  entities!: NamedEntity[];
}
