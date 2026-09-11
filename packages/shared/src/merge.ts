import type { SyncEnvelope, SyncConflict, Syncable, SyncPushPayload, SyncPushResult } from './types';

/**
 * 版本向量合并（last-writer-wins + 冲突检测）。
 *
 * 规则：
 *  - baseVersion === server.version        → 客户端基于最新版本修改，直接接受，版本 +1
 *  - baseVersion < server.version           → 分叉：按 updatedAt 时间戳决胜；
 *                                             客户端更新则接受（版本跟到服务端最新 +1），
 *                                             否则回灌服务端版本作为冲突
 *  - 服务端记录已软删 (deletedAt)           → reason=deleted 冲突，拒绝覆盖
 *  - 服务端不存在（新建）且 baseVersion=0   → 接受
 *
 * 该函数纯函数化，NestJS 同步服务与移动端本地回放共用同一套语义，
 * 并由 vitest 覆盖（见 merge.test.ts）。
 */
export type EntityBucket =
  | 'users'
  | 'speakers'
  | 'audio'
  | 'courses'
  | 'courseItems'
  | 'attempts'
  | 'annotations';

export interface MergeInput<T extends Syncable> {
  entityType: EntityBucket;
  envelope: SyncEnvelope<T>;
  server: T | undefined;
  now: () => Date;
}

export type MergeOutcome<T> =
  | { kind: 'accept'; entity: T; newVersion: number }
  | { kind: 'conflict'; conflict: SyncConflict<T> };

export function mergeRecord<T extends Syncable>(input: MergeInput<T>): MergeOutcome<T> {
  const { entityType, envelope, server, now } = input;
  const client = envelope.entity;
  const base = envelope.baseVersion ?? 0;

  // 新建
  if (!server) {
    if (base > 0) {
      return {
        kind: 'conflict',
        conflict: {
          id: client.id,
          entityType,
          server: server as unknown as T,
          client,
          reason: 'deleted',
        },
      };
    }
    return {
      kind: 'accept',
      entity: stamp(client, Math.max(1, client.version || 1), now),
      newVersion: Math.max(1, client.version || 1),
    };
  }

  // 服务端已软删除 —— 不允许普通同步复活，需走专门的恢复流程
  if (server.deletedAt) {
    return {
      kind: 'conflict',
      conflict: { id: client.id, entityType, server, client, reason: 'deleted' },
    };
  }

  // 快进：客户端基于当前服务端版本
  if (base === server.version) {
    if (samePayload(server, client)) {
      return { kind: 'accept', entity: server, newVersion: server.version };
    }
    return {
      kind: 'accept',
      entity: stamp(client, server.version + 1, now),
      newVersion: server.version + 1,
    };
  }

  // 分叉：两端都从旧版本改过 —— 时间戳决胜
  if (base < server.version) {
    const clientTime = Date.parse(client.updatedAt) || 0;
    const serverTime = Date.parse(server.updatedAt) || 0;
    if (clientTime > serverTime) {
      return {
        kind: 'accept',
        entity: stamp(client, server.version + 1, now),
        newVersion: server.version + 1,
      };
    }
  }

  // 服务端更新（或时间相同）→ 冲突，服务端胜出，客户端需自行处理
  return {
    kind: 'conflict',
    conflict: { id: client.id, entityType, server, client, reason: 'version_conflict' },
  };
}

function stamp<T extends Syncable>(entity: T, version: number, now: () => Date): T {
  return {
    ...entity,
    version,
    updatedAt: entity.updatedAt ? entity.updatedAt : now().toISOString(),
  };
}

/**
 * 粗略负载比较：忽略版本元数据，比较业务字段。
 * 用来识别"无变更推送"，避免无意义抬升版本号。
 */
export function samePayload<T extends Syncable>(a: T, b: T): boolean {
  const strip = (x: T) => {
    const { id: _id, version: _v, deviceId: _d, updatedAt: _u, deletedAt: _del, ...rest } = x as any;
    return rest;
  };
  return stableStringify(strip(a)) === stableStringify(strip(b));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * 批量合并：供服务端同步服务调用。
 * `lookup` 按 id 返回当前服务端记录。
 */
export function mergeBucket<T extends Syncable>(
  entityType: EntityBucket,
  envelopes: SyncEnvelope<T>[],
  lookup: (id: string) => T | undefined | Promise<T | undefined>,
  now: () => Date = () => new Date(),
): {
  outcomes: { id: string; outcome: MergeOutcome<T> }[];
} {
  // 注意：lookup 可能为异步，调用方需先 resolve（服务端在事务内批量预取）。
  const outcomes = envelopes.map((envelope) => {
    const server = lookup(envelope.entity.id) as T | undefined;
    return { id: envelope.entity.id, outcome: mergeRecord({ entityType, envelope, server, now }) };
  });
  return { outcomes };
}

export function summarizePush(result: { accepted: string[]; conflicts: SyncConflict<any>[] }): SyncPushResult {
  return { accepted: result.accepted, conflicts: result.conflicts, rejected: [] };
}

export type { SyncPushPayload, SyncPushResult };
