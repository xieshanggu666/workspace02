import { api } from './api';
import { getDeviceId } from './config';
import { useStore, type OutboxEntry } from './store';
import type { SyncPushPayload, SyncConflict } from '@dialect/shared';

/**
 * 离线同步引擎（移动端）：
 *
 *  1. PUSH：把 outbox 里的本地变更按桶分组推送，baseVersion 为拉取时基线；
 *     成功接受的条目移出 outbox；冲突条目挂起等用户裁决。
 *  2. 媒体补传：元数据推送成功后，再 POST /audio/:id/file 上传二进制
 *     （无网时录音已在本地加密，联网后自动补传）。
 *  3. PULL：增量拉取并合并到本地表，更新游标。
 */
export async function syncNow(): Promise<{ pushed: number; conflicts: number; pulled: number }> {
  const state = useStore.getState();
  if (!state.me) throw new Error('未登录');
  state.setSyncState('pushing', '正在推送本地变更…');

  const deviceId = await getDeviceId();
  const outbox = state.outbox;

  const payload: SyncPushPayload = {
    deviceId,
    speakers: [],
    audio: [],
    courses: [],
    courseItems: [],
    attempts: [],
    annotations: [],
  };
  for (const entry of outbox) {
    (payload as any)[entry.bucket].push({ entity: entry.entity, baseVersion: entry.baseVersion });
  }

  const pushResult = await api.push(payload);
  const acceptedIds = new Set(pushResult.accepted);

  // 上传成功条目的本地媒体文件
  const mediaEntries = outbox.filter((o) => o.localFileUri && acceptedIds.has(o.entity.id));
  for (const entry of mediaEntries) {
    try {
      const uploadPath =
        entry.bucket === 'attempts'
          ? `/practice/attempts/${entry.entity.id}/file`
          : `/audio/${entry.entity.id}/file`;
      const localFileUri: string = entry.localFileUri!;
      await api.uploadFile(uploadPath, localFileUri, 'file');
    } catch (e) {
      // 媒体补传失败不阻塞元数据；保留在 outbox 下轮重试
      acceptedIds.delete(entry.entity.id);
    }
  }

  useStore.getState().shiftOutbox([...acceptedIds]);

  state.setSyncState('pulling', '正在拉取远端更新…');
  const pull = await api.pull(useStore.getState().cursor ?? undefined);

  // 重要：冲突记录【不】在此用服务端版本覆盖本地表。
  // outbox 里的本地编辑仍在，applyPull 会保护这些 id；
  // 本地版本原样保留，由用户在冲突卡片上选择：
  //   - 采用服务端 → resolveConflict(..., 'server') 才写入服务端版本；
  //   - 保留本机   → 以服务端版本为基线强制重推。
  // 未决冲突跨同步轮次累积（按 entityType+id 去重），并已持久化，重启不丢。
  if (pushResult.conflicts.length > 0) {
    const store = useStore.getState();
    const known = new Set(store.conflicts.map((c) => `${c.entityType}:${c.id}`));
    const merged = [
      ...store.conflicts,
      ...pushResult.conflicts.filter((c) => !known.has(`${c.entityType}:${c.id}`)),
    ];
    store.setConflicts(merged);
  }

  let pulledCount = 0;
  pulledCount += pull.speakers.length + pull.audio.length + pull.courses.length;
  pulledCount += pull.courseItems.length + pull.attempts.length + pull.annotations.length;
  useStore.getState().applyPull(pull);

  useStore.getState().setSyncState('idle', null);
  useStore.getState().setLastSyncAt(new Date().toISOString());

  return { pushed: acceptedIds.size, conflicts: pushResult.conflicts.length, pulled: pulledCount };
}

/**
 * 冲突裁决：
 *  - 'server'：丢弃本地改动，写入服务端胜出版本（服务端已删则删除本地记录），
 *    并移除该记录在 outbox 中的待推送项；
 *  - 'client'：以本地版本强制覆盖 —— 以服务端当前版本为基线重推，
 *    成功后本地表版本跟到 server.version + 1。
 */
export async function resolveConflict(
  conflict: SyncConflict<any>,
  winner: 'server' | 'client',
): Promise<void> {
  const store = useStore.getState();
  const bucket = conflict.entityType as OutboxEntry['bucket'];
  const knownBuckets: OutboxEntry['bucket'][] = [
    'speakers', 'audio', 'courses', 'courseItems', 'attempts', 'annotations',
  ];
  if (!knownBuckets.includes(bucket)) {
    store.clearConflict(conflict.entityType, conflict.id);
    return;
  }

  if (winner === 'server') {
    if (conflict.reason === 'deleted' || conflict.server?.deletedAt) {
      store.discardLocalRecord(bucket, conflict.id);
    } else {
      store.applyServerEntity(bucket, conflict.server);
      store.shiftOutbox([conflict.id]);
    }
    store.clearConflict(bucket, conflict.id);
    return;
  }

  // winner === 'client'
  const entry = store.outbox.find((o) => o.bucket === bucket && o.entity.id === conflict.id);
  const forcedVersion = (conflict.server?.version ?? 0) + 1;
  const entity = { ...(entry?.entity ?? conflict.client), version: forcedVersion };
  const deviceId = await getDeviceId();
  const res = await api.push({
    deviceId,
    [bucket]: [{ entity, baseVersion: conflict.server?.version ?? 0 }],
  } as SyncPushPayload);
  if (res.accepted.includes(conflict.id)) {
    store.shiftOutbox([conflict.id]);
    store.applyServerEntity(bucket, entity);
    store.clearConflict(bucket, conflict.id);
  } else {
    const known = new Set(store.conflicts.map((c) => `${c.entityType}:${c.id}`));
    store.setConflicts([
      ...store.conflicts,
      ...res.conflicts.filter((c) => !known.has(`${c.entityType}:${c.id}`)),
    ]);
    throw new Error('强制覆盖仍被拒绝（对方又产生了新版本），请再次同步后重试');
  }
}
