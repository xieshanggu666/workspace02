import { Column, Entity, Index } from 'typeorm';
import { SyncEntity, jsonColumn } from './base.entity';

@Entity('courses')
export class Course extends SyncEntity {
  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 36 })
  coachId: string;

  @Index()
  @Column({ type: 'varchar', length: 64 })
  dialect: string;

  @Column({ type: 'boolean', default: false })
  published: boolean;

  /** 课程条目以独立实体存储；此字段仅作快照便于列表展示 */
  @jsonColumn([])
  itemIds: string[];
}

@Entity('course_items')
export class CourseItem extends SyncEntity {
  @Index()
  @Column({ type: 'varchar', length: 36 })
  courseId: string;

  @Index()
  @Column({ type: 'varchar', length: 36 })
  audioId: string;

  @Column({ type: 'int', default: 0 })
  orderIndex: number;

  @Column({ type: 'int', default: 3 })
  repeatTimes: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  coachTip: string | null;
}
