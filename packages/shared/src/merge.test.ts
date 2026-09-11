import { describe, expect, it } from 'vitest';
import { mergeRecord, samePayload, stableStringify } from './merge';
import type { SpeakerDto } from './types';

const now = () => new Date('2026-09-10T08:00:00.000Z');

function makeSpeaker(overrides: Partial<SpeakerDto> = {}): SpeakerDto {
  return {
    id: 's1',
    version: 1,
    updatedAt: '2026-09-10T08:00:00.000Z',
    deviceId: 'dev-a',
    deletedAt: null,
    code: 'X-1',
    name: '张三',
    dialect: '粤语',
    region: '广州',
    consentStatus: 'granted',
    ...overrides,
  };
}

describe('mergeRecord — 离线版本合并', () => {
  it('服务端不存在且 baseVersion=0：接受为新建 v1', () => {
    const client = makeSpeaker({ version: 1, updatedAt: '2026-09-10T07:00:00.000Z' });
    const r = mergeRecord({ entityType: 'speakers', envelope: { entity: client, baseVersion: 0 }, server: undefined, now });
    expect(r.kind).toBe('accept');
    if (r.kind === 'accept') expect(r.newVersion).toBe(1);
  });

  it('服务端已删除：返回 deleted 冲突，拒绝复活', () => {
    const server = makeSpeaker({ version: 3, deletedAt: '2026-09-10T06:00:00.000Z' });
    const client = makeSpeaker({ version: 3, name: '改名' });
    const r = mergeRecord({ entityType: 'speakers', envelope: { entity: client, baseVersion: 2 }, server, now });
    expect(r.kind).toBe('conflict');
    if (r.kind === 'conflict') expect(r.conflict.reason).toBe('deleted');
  });

  it('快进：baseVersion 等于服务端版本 → 接受并 +1', () => {
    const server = makeSpeaker({ version: 2 });
    const client = makeSpeaker({ version: 2, name: '张三（新）', updatedAt: '2026-09-10T09:00:00.000Z' });
    const r = mergeRecord({ entityType: 'speakers', envelope: { entity: client, baseVersion: 2 }, server, now });
    expect(r.kind).toBe('accept');
    if (r.kind === 'accept') {
      expect(r.newVersion).toBe(3);
      expect(r.entity.name).toBe('张三（新）');
    }
  });

  it('快进但内容无变化：不抬升版本号', () => {
    const server = makeSpeaker({ version: 2 });
    const client = makeSpeaker({ version: 2 });
    const r = mergeRecord({ entityType: 'speakers', envelope: { entity: client, baseVersion: 2 }, server, now });
    expect(r.kind).toBe('accept');
    if (r.kind === 'accept') expect(r.newVersion).toBe(2);
  });

  it('分叉且客户端时间更新：LWW 接受客户端，版本跟到服务端+1', () => {
    const server = makeSpeaker({ version: 4, name: '服务端改名', updatedAt: '2026-09-10T08:00:00.000Z' });
    const client = makeSpeaker({ version: 3, name: '离线设备改名', updatedAt: '2026-09-10T10:00:00.000Z' });
    const r = mergeRecord({ entityType: 'speakers', envelope: { entity: client, baseVersion: 3 }, server, now });
    expect(r.kind).toBe('accept');
    if (r.kind === 'accept') {
      expect(r.entity.name).toBe('离线设备改名');
      expect(r.newVersion).toBe(5);
    }
  });

  it('分叉且服务端时间更新：冲突，服务端胜出', () => {
    const server = makeSpeaker({ version: 4, name: '服务端新名', updatedAt: '2026-09-10T11:00:00.000Z' });
    const client = makeSpeaker({ version: 3, name: '客户端旧名', updatedAt: '2026-09-09T10:00:00.000Z' });
    const r = mergeRecord({ entityType: 'speakers', envelope: { entity: client, baseVersion: 3 }, server, now });
    expect(r.kind).toBe('conflict');
    if (r.kind === 'conflict') {
      expect(r.conflict.reason).toBe('version_conflict');
      expect(r.conflict.server.name).toBe('服务端新名');
    }
  });

  it('baseVersion 大于服务端（异常/回滚库）：按冲突处理', () => {
    const server = makeSpeaker({ version: 1 });
    const client = makeSpeaker({ version: 5 });
    const r = mergeRecord({ entityType: 'speakers', envelope: { entity: client, baseVersion: 9 }, server, now });
    expect(r.kind).toBe('conflict');
  });
});

describe('samePayload / stableStringify', () => {
  it('忽略版本元数据，按键排序后比较', () => {
    const a = makeSpeaker({ version: 1, deviceId: 'x' });
    const b = makeSpeaker({ version: 9, deviceId: 'y' });
    expect(samePayload(a, b)).toBe(true);
    expect(stableStringify({ b: 1, a: [2, 1] })).toBe(stableStringify({ a: [2, 1], b: 1 }));
  });
});
