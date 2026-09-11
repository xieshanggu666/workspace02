import { Column, PrimaryColumn, BeforeInsert, type ColumnOptions } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

/**
 * SQLite(sql.js) 不接受 CURRENT_TIMESTAMP(3) / 毫秒精度参数，
 * MySQL 则保留毫秒精度用于 LWW 排序。实体装饰器求值前需要
 * ensure-env.ts 已把 .env 注入 process.env。
 */
export const IS_SQLITE = process.env.DB_TYPE === 'sqlite';

export const UPDATED_AT_COLUMN: ColumnOptions = IS_SQLITE
  ? { type: 'datetime', default: () => 'CURRENT_TIMESTAMP' }
  : { type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' };

export const NULLABLE_DATETIME_COLUMN: ColumnOptions = IS_SQLITE
  ? { type: 'datetime', nullable: true }
  : { type: 'datetime', precision: 3, nullable: true };

export const REQUIRED_DATETIME_COLUMN: ColumnOptions = IS_SQLITE
  ? { type: 'datetime' }
  : { type: 'datetime', precision: 3 };

/**
 * 所有可同步实体的基类。
 * id 由客户端生成（UUID），保证离线新建不冲突；
 * version 为乐观锁；updatedAt 是同步游标与 LWW 决胜依据。
 */
export abstract class SyncEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id: string;

  @Column({ type: 'int', default: 1 })
  version: number;

  @Column({ type: 'varchar', length: 64, nullable: true })
  deviceId: string | null;

  @Column(UPDATED_AT_COLUMN as any)
  updatedAt: string;

  @Column(NULLABLE_DATETIME_COLUMN as any)
  deletedAt: Date | null;

  @BeforeInsert()
  ensureId() {
    if (!this.id) this.id = uuidv4();
    if (!this.version) this.version = 1;
  }
}

/** JSON 数组/对象列：simple-json 驱动无关（MySQL/sqlite 均可） */
export function jsonColumn(defaultValue: unknown = []) {
  return Column({
    type: 'simple-json',
    nullable: false,
    default: typeof defaultValue === 'string' ? defaultValue : JSON.stringify(defaultValue),
  });
}
