import { Column, CreateDateColumn, Entity, ManyToMany, PrimaryGeneratedColumn } from 'typeorm';
import { News } from './news.entity';

export type EntityType = 'person' | 'org' | 'topic';

@Entity('entities')
export class NamedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  name!: string;

  @Column()
  type!: EntityType;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @ManyToMany(() => News, (news) => news.entities)
  news!: News[];
}
