import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ALL_ENTITIES } from '../entities';
import { TimestampSubscriber } from '../media/timestamp.subscriber';

/**
 * TypeORM 数据源工厂。
 * 默认连 MySQL（root/zhongxin123, 库 dialect）；
 * DB_TYPE=sqlite 时落本地 sql.js 文件，无 MySQL 也能完整演示与测试。
 */
export function buildDataSourceOptions(cfg: {
  type: 'mysql' | 'sqlite';
  host: string; port: number; user: string; password: string; name: string;
  synchronize: boolean; sqliteFile: string;
}): TypeOrmModuleOptions {
  if (cfg.type === 'sqlite') {
    return {
      type: 'sqljs',
      location: cfg.sqliteFile,
      autoSave: true,
      synchronize: true,
      logging: false,
      entities: ALL_ENTITIES,
      subscribers: [TimestampSubscriber],
    };
  }
  return {
    type: 'mysql',
    host: cfg.host,
    port: cfg.port,
    username: cfg.user,
    password: cfg.password,
    database: cfg.name,
    autoLoadEntities: true,
    synchronize: cfg.synchronize,
    charset: 'utf8mb4',
    timezone: '+00:00',
    logging: false,
    entities: ALL_ENTITIES,
    subscribers: [TimestampSubscriber],
  };
}
