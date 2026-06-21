import { Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { News } from './news.entity';

@Entity('highlights')
export class Highlight {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => News)
  news!: News;

  @Column()
  userId!: string;

  @Column({ type: 'text', nullable: true })
  displayName?: string | null;

  @Column()
  startOffset!: number;

  @Column()
  endOffset!: number;

  @Column({ type: 'text' })
  text!: string;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;
}
