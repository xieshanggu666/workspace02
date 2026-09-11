import {
  EntitySubscriberInterface, EventSubscriber, InsertEvent, UpdateEvent,
} from 'typeorm';
import { SyncEntity } from '../entities/base.entity';

/**
 * 给所有同步实体强制盖「服务端提交时间」。
 *
 * 关键：不能信任客户端时间。无论记录从 REST、sync push 还是软删写入，
 * serverUpdatedAt 都以数据库/应用服务器时钟为准，同步游标只认它。
 * 同步 DTO 里不包含该字段，客户端无法注入。
 *
 * 注意：QueryBuilder.update() 不触发订阅器，那些写路径必须显式 set serverUpdatedAt
 *（已在 speakers.service / courses.service 等处处理）。
 */
@EventSubscriber()
export class TimestampSubscriber implements EntitySubscriberInterface {
  beforeInsert(event: InsertEvent<unknown>): void {
    if (isSyncEntity(event.entity)) {
      (event.entity as any).serverUpdatedAt = new Date();
      if (!(event.entity as any).updatedAt) {
        (event.entity as any).updatedAt = new Date() as any;
      }
    }
  }

  beforeUpdate(event: UpdateEvent<unknown>): void {
    if (event.entity && isSyncEntity(event.entity)) {
      (event.entity as any).serverUpdatedAt = new Date();
    }
    // QueryBuilder 更新没有 event.entity，无法在此统一盖章，由调用方负责。
  }
}

function isSyncEntity(entity: unknown): boolean {
  if (!entity || typeof entity !== 'object') return false;
  // SyncEntity 的抽象子类都有 id/version/serverUpdatedAt 列；用列存在性判断
  return 'id' in (entity as Record<string, unknown>);
}
