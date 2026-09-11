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
const uploadMock = vi.fn();
vi.mock('./api', () => ({
  api: {
    push: (...args: any[]) => pushMock(...(args as [any])),
    pull: (...args: any[]) => pullMock(...(args as [any])),
    uploadFile: (...args: any[]) => uploadMock(...(args as [any])),
  },
}));

// sync.ts 静态引入了本地加密（含 RN 原生依赖），测试中模拟“解密出明文临时文件”
const decryptMock = vi.fn(async (uri: string, id: string, ext = 'wav') => ({
  plainUri: `/tmp/plain-${id}.${ext}`,
  cleanup: vi.fn(async () => {}),
}));
vi.mock('./crypto', () => ({
  decryptToUploadFile: (...args: any[]) => decryptMock(...args),
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
  uploadMock.mockReset();
  decryptMock.mockClear();
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

describe('syncNow —— 媒体必须解密后再上传', () => {
  it('outbox 中的加密跟读先解密成明文临时文件再 multipart 上传，且按 mime 决定扩展名', async () => {
    const encUri = '/tmp/cache/att-x.abcd1234.enc';
    useStore.getState().upsertLocal(
      'attempts',
      {
        id: 'att-x', studentId: 'u1', courseItemId: 'ci1', audioId: 'a1',
        durationSec: 1, mime: 'audio/mp4', waveformPeaks: [0.2], score: null,
        createdAt: '2026-09-11T00:00:00.000Z', version: 1, updatedAt: '2026-09-11T00:00:00.000Z',
      },
      { localFileUri: encUri },
    );
    pushMock.mockResolvedValue({ accepted: ['att-x'], conflicts: [], rejected: [] });
    await syncNow();

    // 先解密，且传入 m4a 扩展名
    expect(decryptMock).toHaveBeenCalledWith(encUri, 'att-x', 'm4a');
    // 上传的是解密后的明文路径，而不是 .enc
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const call = uploadMock.mock.calls[0] as [string, string, string, string];
    const [uploadPath, uploadedUri, , ext] = call;
    expect(uploadPath).toBe('/practice/attempts/att-x/file');
    expect(uploadedUri).toBe('/tmp/plain-att-x.m4a');
    expect(uploadedUri.endsWith('.enc')).toBe(false);
    expect(ext).toBe('m4a');
  });

  it('媒体解密/上传失败：attempt 留在 outbox 下轮重试（元数据也不标记为已完成）', async () => {
    useStore.getState().upsertLocal(
      'attempts',
      {
        id: 'att-y', studentId: 'u1', courseItemId: 'ci1', audioId: 'a1',
        durationSec: 1, mime: 'audio/wav', waveformPeaks: [], score: null,
        createdAt: '2026-09-11T00:00:00.000Z', version: 1, updatedAt: '2026-09-11T00:00:00.000Z',
      },
      { localFileUri: '/tmp/cache/att-y.eeee5678.enc' },
    );
    pushMock.mockResolvedValue({ accepted: ['att-y'], conflicts: [], rejected: [] });
    uploadMock.mockRejectedValueOnce(new Error('network down'));
    await syncNow();
    expect(useStore.getState().outbox.map((o) => o.entity.id)).toContain('att-y');
  });
});
