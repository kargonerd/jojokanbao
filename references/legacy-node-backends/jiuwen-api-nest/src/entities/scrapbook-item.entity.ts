import { Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { News } from './news.entity';

@Entity('scrapbook_items')
export class ScrapbookItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => News)
  news!: News;

  @ManyToOne(() => News)
  relatedNews!: News;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ type: 'float', default: 0 })
  score!: number;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;
}
