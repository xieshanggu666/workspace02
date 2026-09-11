import { Column, Entity, Index } from 'typeorm';
import { SyncEntity } from './base.entity';

export type UserRole = 'investigator' | 'speaker' | 'coach' | 'student' | 'admin';

@Entity('users')
export class User extends SyncEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  username: string;

  @Column({ type: 'varchar', length: 128 })
  displayName: string;

  /** bcrypt 哈希 */
  @Column({ type: 'varchar', length: 100, select: false })
  passwordHash: string;

  @Column({ type: 'varchar', length: 16, default: 'student' })
  role: UserRole;
}
