import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncPullResult, SyncPushPayload, SyncPushResult, UserDto } from '@dialect/shared';

// 屏蔽真实网络与原生设备 ID
vi.mock('./config', () => ({
  getDeviceId: vi.fn(async () => 'dev-test'),
  getApiBase: vi.fn(async () => 'http://test/api'),
  setApiBase: vi.fn(),
}));

const pushMock = vi.fn();
const pullMock = vi.fn();
vi.mock('./api', () => ({
  api: {
    push: (...args: any[]) => pushMock(...args),
    pull: (...args: any[]) => pullMock(...args),
  },
}));

import { syncNow, resolveConflict } from './sync';
import { useStore } from './store';
import type { SpeakerDto } from '@dialect/shared';

function speaker(over: Partial<SpeakerDto> = {}): SpeakerDto {
  return {
    id: 's1', code: 'C1', name: 'X', dialect: '粤语', region: '广州',
    consentStatus: 'granted', version: 1, updatedAt: '2026-09-10T00:00:00.000Z', ...over,
  };
}

const me: UserDto = {
  id: 'u1', username: 'investigator1', displayName: '调查员', role: 'investigator',
  version: 1, updatedAt: '2026-09-01T00:00:00Z',
};

const emptyPull = (): SyncPullResult => ({
  cursor: '2026-09-11T00:00:00.000Z',
  users: [], speakers: [], audio: [], courses: [], courseItems: [], attempts: [], annotations: [],
});

function resetStore() {
  useStore.setState({
    hydrated: true, me, cursor: null,
    speakers: {}, audio: {}, courses: {}, courseItems: {}, attempts: {}, annotations: {},
    localMedia: {}, outbox: [], conflicts: [], lastSyncAt: null,
    syncState: 'idle', syncMessage: null,
  });
}

beforeEach(() => {
  resetStore();
  pushMock.mockReset();
  pullMock.mockReset();
  pullMock.mockResolvedValue(emptyPull());
});

describe('syncNow —— 冲突时本地未推送编辑不得丢失', () => {
  it('push 返回 version_conflict：本地表保留离线版本、outbox 保留、冲突挂起，pull 也不覆盖', async () => {
    // 1. 基线：服务端 v3
    useStore.getState().applyPull({
      ...emptyPull(),
      speakers: [speaker({ name: '服务端 v3', version: 3, updatedAt: '2026-09-10T08:00:00Z' })],
    });
    // 2. 离线编辑（baseVersion 应为 3）
    useStore.getState().upsertLocal('speakers', {
      ...useStore.getState().speakers['s1'],
      name: '离线改的名字',
    });

    // 3. 推送时服务端已到 v4（另一设备改过）→ 冲突，且 pull 把 v4 也带回来
    const serverV4 = speaker({ name: '服务端 v4', version: 4, updatedAt: '2026-09-11T09:00:00Z' });
    pushMock.mockResolvedValue({
      accepted: [],
      conflicts: [{ id: 's1', entityType: 'speakers', server: serverV4, client: useStore.getState().speakers['s1'], reason: 'version_conflict' }],
      rejected: [],
    } satisfies SyncPushResult);
    pullMock.mockResolvedValue({ ...emptyPull(), speakers: [serverV4] });

    const r = await syncNow();

    // 本地编辑仍在，没有被 v4 覆盖
    expect(r.conflicts).toBe(1);
    expect(useStore.getState().speakers['s1'].name).toBe('离线改的名字');
    expect(useStore.getState().outbox).toHaveLength(1);
    expect(useStore.getState().outbox[0].baseVersion).toBe(3);
    expect(useStore.getState().conflicts).toHaveLength(1);
    expect(useStore.getState().conflicts[0].server.name).toBe('服务端 v4');
  });

  it('裁决为「采用服务端」：写入服务端版本、清空 outbox 项与冲突', async () => {
    const client = speaker({ name: '离线版', version: 3, updatedAt: '2026-09-11T08:00:00Z' });
    const serverV4 = speaker({ name: '服务端 v4', version: 4, updatedAt: '2026-09-11T09:00:00Z' });
    useStore.getState().upsertLocal('speakers', client);
    useStore.setState({ conflicts: [{ id: 's1', entityType: 'speakers', server: serverV4, client, reason: 'version_conflict' }] });

    await resolveConflict(useStore.getState().conflicts[0], 'server');

    expect(useStore.getState().speakers['s1'].name).toBe('服务端 v4');
    expect(useStore.getState().outbox).toHaveLength(0);
    expect(useStore.getState().conflicts).toHaveLength(0);
  });

  it('裁决为「保留本机」：以服务端版本为基线重推，成功后本地版本号跟到 v5', async () => {
    const client = speaker({ name: '离线版', version: 3, updatedAt: '2026-09-11T10:00:00Z' });
    const serverV4 = speaker({ name: '服务端 v4', version: 4, updatedAt: '2026-09-11T09:00:00Z' });
    useStore.getState().upsertLocal('speakers', client);
    useStore.setState({ conflicts: [{ id: 's1', entityType: 'speakers', server: serverV4, client, reason: 'version_conflict' }] });

    pushMock.mockImplementation(async (payload: SyncPushPayload) => {
      expect(payload.speakers?.[0].baseVersion).toBe(4);
      expect((payload.speakers?.[0].entity as SpeakerDto).version).toBe(5);
      return { accepted: ['s1'], conflicts: [], rejected: [] } satisfies SyncPushResult;
    });

    await resolveConflict(useStore.getState().conflicts[0], 'client');

    expect(useStore.getState().speakers['s1'].name).toBe('离线版');
    expect(useStore.getState().speakers['s1'].version).toBe(5);
    expect(useStore.getState().outbox).toHaveLength(0);
    expect(useStore.getState().conflicts).toHaveLength(0);
  });

  it('服务端已删除（reason=deleted）时裁决「采用服务端」：本地记录被丢弃', async () => {
    const client = speaker({ name: '离线版', version: 3 });
    useStore.getState().upsertLocal('speakers', client);
    useStore.setState({
      speakers: { s1: client },
      conflicts: [{ id: 's1', entityType: 'speakers', server: undefined as any, client, reason: 'deleted' }],
    });

    await resolveConflict(useStore.getState().conflicts[0], 'server');

    expect(useStore.getState().speakers['s1']).toBeUndefined();
    expect(useStore.getState().outbox).toHaveLength(0);
    expect(useStore.getState().conflicts).toHaveLength(0);
  });
});
