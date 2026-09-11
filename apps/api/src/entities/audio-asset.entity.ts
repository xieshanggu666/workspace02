import { Column, Entity, Index } from 'typeorm';
import { SyncEntity, jsonColumn, REQUIRED_DATETIME_COLUMN } from './base.entity';

export type AudioStatus = 'draft' | 'annotated' | 'published' | 'restricted';

export interface SyllableMark {
  start: number;
  end: number;
  label: string;
  gloss?: string;
}

@Entity('audio_assets')
export class AudioAsset extends SyncEntity {
  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Index()
  @Column({ type: 'varchar', length: 36 })
  speakerId: string;

  @Column({ type: 'varchar', length: 36 })
  ownerId: string;

  @Index()
  @Column({ type: 'varchar', length: 64 })
  dialect: string;

  /** 服务器上的存储相对路径（加密文件 .enc） */
  @Column({ type: 'varchar', length: 255, nullable: true })
  filePath: string | null;

  @Column({ type: 'double precision', default: 0 })
  durationSec: number;

  @Column({ type: 'int', default: 16000 })
  sampleRate: number;

  @Column({ type: 'int', default: 1 })
  channels: number;

  @Column({ type: 'varchar', length: 32, default: 'audio/wav' })
  mime: string;

  @jsonColumn([])
  waveformPeaks: number[];

  @Column({ type: 'text', nullable: true })
  transcript: string | null;

  @Column({ type: 'text', nullable: true })
  translation: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  ipa: string | null;

  @jsonColumn([])
  syllables: SyllableMark[];

  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status: AudioStatus;

  @Column({ type: 'boolean', default: false })
  sensitive: boolean;

  @Column({ type: 'int', nullable: true })
  keyVersion: number | null;

  @Column(REQUIRED_DATETIME_COLUMN as any)
  recordedAt: Date;
}
