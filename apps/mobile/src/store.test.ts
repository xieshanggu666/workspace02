import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './store';
import type { SpeakerDto, AudioAssetDto, SyncPullResult } from '@dialect/shared';

/**
 * 回归测试：离线未推送的本地修改不得被 pull 覆盖；
 * baseVersion 不得因连续本地编辑而漂移。
 */

function speaker(id: string, overrides: Partial<SpeakerDto> = {}): SpeakerDto {
  return {
    id,
    code: `C-${id}`,
    name: '发音人',
    dialect: '粤语',
    region: '广州',
    consentStatus: 'granted',
    version: 1,
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

function audio(id: string, overrides: Partial<AudioAssetDto> = {}): AudioAssetDto {
  return {
    id,
    title: '录音',
    speakerId: 'spk-1',
    ownerId: 'u1',
    dialect: '粤语',
    durationSec: 1,
    sampleRate: 16000,
    channels: 1,
    mime: 'audio/wav',
    waveformPeaks: [0.1],
    syllables: [],
    status: 'annotated',
    sensitive: false,
    recordedAt: '2026-09-10T00:00:00.000Z',
    version: 1,
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

function emptyPull(overrides: Partial<SyncPullResult> = {}): SyncPullResult {
  return {
    cursor: '2026-09-11T00:00:00.000Z',
    users: [], speakers: [], audio: [], courses: [],
    courseItems: [], attempts: [], annotations: [],
    ...overrides,
  };
}

function resetStore() {
  useStore.setState({
    hydrated: true,
    me: null,
    cursor: null,
    speakers: {}, audio: {}, courses: {}, courseItems: {}, attempts: {}, annotations: {},
    localMedia: {},
    outbox: [],
    conflicts: [],
    lastSyncAt: null,
    syncState: 'idle',
    syncMessage: null,
  });
}

beforeEach(resetStore);

describe('applyPull 不得覆盖未推送的本地编辑', () => {
  it('说话人：已同步 v3 的记录离线改名后，带更新的 pull 不得覆盖本地版本', () => {
    // 模拟之前一次 pull 得到 v3
    useStore.getState().applyPull(
      emptyPull({ speakers: [speaker('s1', { name: '服务端原名', version: 3, updatedAt: '2026-09-10T08:00:00.000Z' })] }),
    );

    // 离线编辑（进 outbox）
    useStore.getState().upsertLocal('speakers', {
      ...useStore.getState().speakers['s1'],
      name: '我在山里改的名字',
    });

    // 另一台设备把服务端推到 v4 后再 pull
    useStore.getState().applyPull(
      emptyPull({
        speakers: [speaker('s1', { name: '另一设备改的名字', version: 4, updatedAt: '2026-09-11T09:00:00.000Z' })],
      }),
    );

    expect(useStore.getState().speakers['s1'].name).toBe('我在山里改的名字');
    expect(useStore.getState().outbox).toHaveLength(1);
    expect(useStore.getState().outbox[0].baseVersion).toBe(3);
  });

  it('音频：离线补音节切分后，pull 不覆盖 syllables/transcript', () => {
    useStore.getState().applyPull(
      emptyPull({ audio: [audio('a1', { title: '原句', version: 2, updatedAt: '2026-09-10T08:00:00Z' })] }),
    );
    useStore.getState().upsertLocal('audio', {
      ...useStore.getState().audio['a1'],
      syllables: [{ start: 0, end: 0.5, label: 'nei˨˧', gloss: '你' }],
      transcript: '你好',
    });
    useStore.getState().applyPull(
      emptyPull({
        audio: [audio('a1', { title: '原句', status: 'published', version: 3, updatedAt: '2026-09-11T10:00:00Z' })],
      }),
    );
    const kept = useStore.getState().audio['a1'];
    expect(kept.transcript).toBe('你好');
    expect(kept.syllables).toHaveLength(1);
    expect(kept.status).toBe('annotated'); // 本地版本完整保留
  });

  it('本地软删（墓碑待推送）不被 pull 的远端活记录复活', () => {
    useStore.getState().applyPull(
      emptyPull({ speakers: [speaker('s2', { name: '待删', version: 1 })] }),
    );
    useStore.getState().removeLocal('speakers', 's2');
    useStore.getState().applyPull(
      emptyPull({ speakers: [speaker('s2', { name: '待删', version: 2, updatedAt: '2026-09-11T10:00:00Z' })] }),
    );
    expect(useStore.getState().speakers['s2'].deletedAt).toBeTruthy();
    expect(useStore.getState().outbox[0].entity.deletedAt).toBeTruthy();
  });

  it('无待推送编辑时，pull 正常更新（保护机制不误伤）', () => {
    useStore.getState().applyPull(emptyPull({ speakers: [speaker('s3', { name: '旧', version: 1 })] }));
    useStore.getState().applyPull(
      emptyPull({ speakers: [speaker('s3', { name: '新', version: 2, updatedAt: '2026-09-11T10:00:00Z' })] }),
    );
    expect(useStore.getState().speakers['s3'].name).toBe('新');
    expect(useStore.getState().speakers['s3'].version).toBe(2);
  });

  it('推送成功（移出 outbox）后，下一次 pull 正常收敛到服务端版本', () => {
    useStore.getState().applyPull(emptyPull({ speakers: [speaker('s4', { name: 'A', version: 1 })] }));
    useStore.getState().upsertLocal('speakers', { ...useStore.getState().speakers['s4'], name: '本地改' });
    useStore.getState().shiftOutbox(['s4']); // 服务端已接受
    useStore.getState().applyPull(
      emptyPull({ speakers: [speaker('s4', { name: '服务端收敛', version: 2, updatedAt: '2026-09-11T10:00:00Z' })] }),
    );
    expect(useStore.getState().speakers['s4'].name).toBe('服务端收敛');
  });
});

describe('baseVersion 在连续离线编辑中保持为同步基线', () => {
  it('本地新建记录连续编辑 3 次：outbox 仅 1 条，baseVersion 恒为 0', () => {
    for (const name of ['第一次', '第二次', '第三次']) {
      useStore.getState().upsertLocal('speakers', speaker('local-1', { name }));
    }
    const box = useStore.getState().outbox;
    expect(box).toHaveLength(1);
    expect(box[0].baseVersion).toBe(0);
    expect(box[0].entity.name).toBe('第三次');
  });

  it('服务端 v3 的记录连续离线编辑：baseVersion 恒为 3（不会漂到 4/5）', () => {
    useStore.getState().applyPull(
      emptyPull({ speakers: [speaker('s5', { name: '原', version: 3 })] }),
    );
    useStore.getState().upsertLocal('speakers', { ...useStore.getState().speakers['s5'], name: '改1' });
    useStore.getState().upsertLocal('speakers', { ...useStore.getState().speakers['s5'], name: '改2' });
    const box = useStore.getState().outbox;
    expect(box).toHaveLength(1);
    expect(box[0].baseVersion).toBe(3);
  });
});

describe('removeLocal 语义', () => {
  it('从未同步的本地新建记录被删除：直接丢弃，不产生墓碑推送', () => {
    useStore.getState().upsertLocal('speakers', speaker('local-2', { name: '临时' }));
    useStore.getState().removeLocal('speakers', 'local-2');
    expect(useStore.getState().speakers['local-2']).toBeUndefined();
    expect(useStore.getState().outbox).toHaveLength(0);
  });
});
