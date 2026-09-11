import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

// 必须在 import AppModule 之前设置：测试全程走 sql.js，无需 MySQL
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_FILE = path.join(
  mkdtempSync(path.join(tmpdir(), 'dialect-test-')),
  'test.sqlite',
);
process.env.UPLOAD_DIR = path.join(path.dirname(process.env.SQLITE_FILE), 'uploads');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AppModule } = await import('../src/app.module');
const { SpeakersService } = await import('../src/resources/speakers.service');
const { AudioService } = await import('../src/resources/audio.service');
const { CoursesService } = await import('../src/resources/courses.service');
const { SyncService } = await import('../src/sync/sync.service');
const entities = await import('../src/entities');

describe('端到端（sql.js）：授权闸门 / 加密媒体 / 离线同步', () => {
  let app: any;
  let ds: DataSource;
  let speakers: SpeakersService;
  let audio: AudioService;
  let courses: CoursesService;
  let sync: SyncService;

  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await app.init();
    ds = app.get(DataSource);
    speakers = app.get(SpeakersService);
    audio = app.get(AudioService);
    courses = app.get(CoursesService);
    sync = app.get(SyncService);

    // 一个调查员账号
    await ds.getRepository(entities.User).save(
      ds.getRepository(entities.User).create({
        id: 'u1', username: 'inv', displayName: '调查员', role: 'investigator',
        passwordHash: await bcrypt.hash('x', 10), version: 1,
      }),
    );
  });

  afterAll(async () => {
    await app.close();
    rmSync(path.dirname(process.env.SQLITE_FILE!), { recursive: true, force: true });
  });

  it('说话人建档：默认 pending，授权后记录哈希', async () => {
    const created = await speakers.upsert({
      id: 's1', code: 'T-1', name: '测试发音人', dialect: '粤语', region: '广州',
      consentStatus: 'pending', version: 1, updatedAt: new Date().toISOString(),
    } as any);
    expect(created.consentStatus).toBe('pending');

    const granted = await speakers.grantConsent('s1', {
      scope: 'research',
      agreementText: '本人同意录音用于方言研究。',
    });
    expect(granted.consentStatus).toBe('granted');
    expect(granted.consentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('敏感录音：学员无权读取，调查员可读且读到解密后的明文 WAV', async () => {
    // 待授权说话人 + 敏感音频
    await speakers.upsert({
      id: 's2', code: 'T-2', name: '待签发音人', dialect: '客家话', region: '梅州',
      consentStatus: 'pending', version: 1, updatedAt: new Date().toISOString(),
    } as any);
    await audio.upsert({
      id: 'a1', title: '受限录音', speakerId: 's2', ownerId: 'u1', dialect: '客家话',
      durationSec: 0.1, sampleRate: 16000, channels: 1, mime: 'audio/wav',
      waveformPeaks: [0.5], syllables: [], status: 'restricted', sensitive: true,
      recordedAt: new Date().toISOString(), version: 1, updatedAt: new Date().toISOString(),
    } as any);
    await audio.attachFile('a1', Buffer.from('RIFF\x00\x00\x00\x00WAVE-restricted-content'));

    const stored = await audio.getEntity('a1');
    expect(stored.keyVersion).toBe(1);

    await expect(audio.readMedia('a1', 'student')).rejects.toMatchObject({ status: 403 });
    const { data, mime } = await audio.readMedia('a1', 'investigator');
    expect(mime).toBe('audio/wav');
    expect(data.toString('latin1').startsWith('RIFF')).toBe(true);
  });

  it('撤回授权：学员/教练被挡在合规闸门之外（仅调查员可调取归档）', async () => {
    await audio.upsert({
      id: 'a2', title: '普通录音', speakerId: 's1', ownerId: 'u1', dialect: '粤语',
      durationSec: 0.1, sampleRate: 16000, channels: 1, mime: 'audio/wav',
      waveformPeaks: [0.2], syllables: [], status: 'annotated', sensitive: false,
      recordedAt: new Date().toISOString(), version: 1, updatedAt: new Date().toISOString(),
    } as any);
    await audio.attachFile('a2', Buffer.from('RIFFxxxxWAVE-public'));
    expect((await audio.readMedia('a2', 'student')).data.toString()).toBe('RIFFxxxxWAVE-public');

    await speakers.revokeConsent('s1');
    await expect(audio.readMedia('a2', 'student')).rejects.toMatchObject({ status: 403 });
    expect((await audio.readMedia('a2', 'investigator')).data.toString()).toBe('RIFFxxxxWAVE-public');
  });

  it('同步：推送新说话人 → 拉取可见；基于旧版本的二次推送产生冲突', async () => {
    const pushResult = await sync.push(
      {
        deviceId: 'dev-test',
        speakers: [{
          baseVersion: 0,
          entity: {
            id: 's3', code: 'T-3', name: '离线新建', dialect: '吴语', region: '苏州',
            consentStatus: 'granted', version: 1, updatedAt: '2026-09-09T10:00:00.000Z',
          } as any,
        }],
      },
      'investigator',
    );
    expect(pushResult.accepted).toContain('s3');
    expect(pushResult.conflicts).toHaveLength(0);

    const pulled = await sync.pull(undefined, 'investigator');
    expect(pulled.speakers.some((s) => s.id === 's3')).toBe(true);
    expect(pulled.cursor > new Date(0).toISOString()).toBe(true);

    // 离线分叉：另一设备仍以 baseVersion=1（已被上面抬到 1，再推同 base=1 即快进）；
    // 先制造服务端 v2，再以 v1 推更旧时间戳 → 冲突
    await speakers.upsert({
      id: 's3', code: 'T-3', name: '服务端改名', dialect: '吴语', region: '苏州',
      consentStatus: 'granted', version: 1, updatedAt: '2026-09-10T12:00:00.000Z',
    } as any);

    const clash = await sync.push(
      {
        deviceId: 'dev-offline',
        speakers: [{
          baseVersion: 1,
          entity: {
            id: 's3', code: 'T-3', name: '离线旧改名', dialect: '吴语', region: '苏州',
            consentStatus: 'granted', version: 2, updatedAt: '2026-09-10T08:00:00.000Z',
          } as any,
        }],
      },
      'investigator',
    );
    expect(clash.accepted).not.toContain('s3');
    expect(clash.conflicts[0]).toMatchObject({ id: 's3', reason: 'version_conflict' });
    expect(clash.conflicts[0].server.name).toBe('服务端改名');
  });

  it('同步角色闸门：学员不能推送 speakers', async () => {
    await expect(
      sync.push(
        { deviceId: 'd', speakers: [{ baseVersion: 0, entity: { id: 'x' } as any }] },
        'student',
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('课程整课保存：条目 upsert 对账，移除的条目被软删', async () => {
    const dto = {
      id: 'c1', title: '测试课', coachId: 'u1', dialect: '粤语', published: false,
      version: 1, updatedAt: new Date().toISOString(),
      items: [
        { id: 'i1', courseId: 'c1', audioId: 'a2', orderIndex: 0, repeatTimes: 2, version: 1, updatedAt: new Date().toISOString() },
        { id: 'i2', courseId: 'c1', audioId: 'a1', orderIndex: 1, repeatTimes: 4, version: 1, updatedAt: new Date().toISOString() },
      ],
    } as any;
    await courses.saveCourse(dto);
    let saved = await courses.getDto('c1');
    expect(saved.items.map((i) => i.id)).toEqual(['i1', 'i2']);

    // 第二版：去掉 i2，新增 i3
    await courses.saveCourse({
      ...dto,
      items: [
        { ...dto.items[0] },
        { id: 'i3', courseId: 'c1', audioId: 'a1', orderIndex: 1, repeatTimes: 1, version: 1, updatedAt: new Date().toISOString() },
      ],
    });
    saved = await courses.getDto('c1');
    expect(saved.items.map((i) => i.id)).toEqual(['i1', 'i3']);

    const stale = await ds.getRepository(entities.CourseItem).findOneBy({ id: 'i2' });
    expect(stale?.deletedAt).not.toBeNull();
  });
});
