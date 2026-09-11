import { Column, Entity, Index } from 'typeorm';
import { SyncEntity, NULLABLE_DATETIME_COLUMN } from './base.entity';

export type ConsentStatus = 'granted' | 'revoked' | 'pending';
export type ConsentScope = 'research' | 'course' | 'public';

@Entity('speakers')
export class Speaker extends SyncEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  code: string;

  @Column({ type: 'varchar', length: 128 })
  name: string;

  @Column({ type: 'varchar', length: 1, nullable: true })
  gender: 'M' | 'F' | 'O' | null;

  @Column({ type: 'int', nullable: true })
  birthYear: number | null;

  @Column({ type: 'varchar', length: 64 })
  dialect: string;

  @Column({ type: 'varchar', length: 128 })
  region: string;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  consentStatus: ConsentStatus;

  @Column({ type: 'varchar', length: 16, nullable: true })
  consentScope: ConsentScope | null;

  @Column(NULLABLE_DATETIME_COLUMN as any)
  consentSignedAt: Date | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  consentHash: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;
}
