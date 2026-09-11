import { Column, Entity, Index } from 'typeorm';
import { SyncEntity, jsonColumn, REQUIRED_DATETIME_COLUMN } from './base.entity';

@Entity('practice_attempts')
export class PracticeAttempt extends SyncEntity {
  @Index()
  @Column({ type: 'varchar', length: 36 })
  studentId: string;

  @Index()
  @Column({ type: 'varchar', length: 36 })
  courseItemId: string;

  @Column({ type: 'varchar', length: 36 })
  audioId: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  filePath: string | null;

  @Column({ type: 'double precision', default: 0 })
  durationSec: number;

  @jsonColumn([])
  waveformPeaks: number[];

  @Column({ type: 'int', nullable: true })
  score: number | null;

  @Column(REQUIRED_DATETIME_COLUMN as any)
  createdAt: Date;
}

@Entity('annotations')
export class Annotation extends SyncEntity {
  @Index()
  @Column({ type: 'varchar', length: 36 })
  attemptId: string;

  @Column({ type: 'varchar', length: 36 })
  coachId: string;

  @Column({ type: 'double precision' })
  atSec: number;

  @Column({ type: 'text' })
  comment: string;

  @Column({ type: 'int', nullable: true })
  rating: number | null;
}
