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
  useStore.getState().setConflicts(pushResult.conflicts);

  state.setSyncState('pulling', '正在拉取远端更新…');
  const pull = await api.pull(useStore.getState().cursor ?? undefined);

  // 冲突里服务端胜出的版本直接落库
  for (const c of pushResult.conflicts) {
    upsertConflictServerVersion(c);
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
 *  - 'server'：丢弃本地改动（默认，applyPull 已落库；这里把残留的本地 outbox 清掉）
 *  - 'client'：以本地版本强制覆盖 —— 把 baseVersion 抬到冲突中服务端版本再推一次
 */
export async function resolveConflict(
  conflict: SyncConflict<any>,
  winner: 'server' | 'client',
): Promise<void> {
  const store = useStore.getState();
  const bucket = conflict.entityType as OutboxEntry['bucket'];

  if (winner === 'server') {
    store.applyServerEntity(bucket as any, conflict.server);
    store.shiftOutbox([conflict.id]);
  } else {
    const entry = store.outbox.find((o) => o.bucket === bucket && o.entity.id === conflict.id);
    const entity = { ...(entry?.entity ?? conflict.client), version: conflict.server.version };
    const deviceId = await getDeviceId();
    const res = await api.push({
      deviceId,
      [bucket]: [{ entity, baseVersion: conflict.server.version }],
    } as SyncPushPayload);
    if (res.accepted.includes(conflict.id)) {
      store.shiftOutbox([conflict.id]);
      store.applyServerEntity(bucket as any, entity);
    } else {
      store.setConflicts(res.conflicts);
      throw new Error('强制覆盖仍被拒绝（对方又产生了新版本），请刷新后重试');
    }
  }

  // 从冲突列表移除
  useStore.setState({ conflicts: useStore.getState().conflicts.filter((c) => c.id !== conflict.id) });
}

function upsertConflictServerVersion(c: SyncConflict<any>) {
  const bucket = c.entityType as OutboxEntry['bucket'];
  const knownBuckets: string[] = ['speakers', 'audio', 'courses', 'courseItems', 'attempts', 'annotations'];
  if (!knownBuckets.includes(bucket)) return;
  useStore.getState().applyServerEntity(bucket as any, c.server);
}
