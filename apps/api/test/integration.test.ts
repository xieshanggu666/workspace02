import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

// 必须在 import AppModule 之前设置：测试全程走 sql.js，无需 MySQL
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_FILE = path.join(
  mkdtempSync(path.join(tmpdir(), 'dialect-test-')),
  'test.sqlite',
);
process.env.UPLOAD_DIR = path.join(path.dirname(process.env.SQLITE_FILE!), 'uploads');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AppModule } = await import('../src/app.module');
const { SpeakersService } = await import('../src/resources/speakers.service');
const { AudioService } = await import('../src/resources/audio.service');
const { CoursesService } = await import('../src/resources/courses.service');
const { PracticeService } = await import('../src/resources/practice.service');
const { SyncService } = await import('../src/sync/sync.service');
const entities = await import('../src/entities');

describe('端到端（sql.js）：授权闸门 / 加密媒体 / 离线同步 / 练习隐私', () => {
  let app: any;
  let ds: DataSource;
  let speakers: SpeakersService;
  let audio: AudioService;
  let courses: CoursesService;
  let practice: PracticeService;
  let sync: SyncService;

  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await app.init();
    ds = app.get(DataSource);
    speakers = app.get(SpeakersService);
    audio = app.get(AudioService);
    courses = app.get(CoursesService);
    practice = app.get(PracticeService);
    sync = app.get(SyncService);

    const hash = await bcrypt.hash('x', 10);
    const users: Array<[string, string, string]> = [
      ['u1', 'inv', 'investigator'],
      ['coach1', 'coach1', 'coach'],
      ['stu-a', 'stuA', 'student'],
      ['stu-b', 'stuB', 'student'],
    ];
    for (const [id, username, role] of users) {
      await ds.getRepository(entities.User).save(
        ds.getRepository(entities.User).create({
          id, username, displayName: username, role, passwordHash: hash, version: 1,
        }),
      );
    }
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
      'u1',
    );
    expect(pushResult.accepted).toContain('s3');
    expect(pushResult.conflicts).toHaveLength(0);

    const pulled = await sync.pull(undefined, 'investigator', 'u1');
    expect(pulled.speakers.some((s) => s.id === 's3')).toBe(true);
    expect(pulled.cursor > new Date(0).toISOString()).toBe(true);

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
      'u1',
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
        'stu-a',
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

  // ================= 学员练习隐私与越权防护 =================

  it('练习归属：学员 B 无法提交/改写学员 A 的 attempt（REST 与 sync 双通道拦截）', async () => {
    const dto = {
      id: 'att-priv-1', studentId: 'stu-a', courseItemId: 'i1', audioId: 'a2',
      durationSec: 1, waveformPeaks: [0.2], score: null,
      createdAt: new Date().toISOString(), version: 1, updatedAt: new Date().toISOString(),
    } as any;
    await practice.submitAttempt(dto, 'stu-a');

    // B 试图用同一 id 提交（哪怕伪造 studentId=stu-a）→ 403
    await expect(
      practice.submitAttempt({ ...dto, studentId: 'stu-a' }, 'stu-b'),
    ).rejects.toMatchObject({ status: 403 });

    // B 试图通过 sync push 覆盖 A 的记录 → 403（事务回滚）
    await expect(
      sync.push(
        { deviceId: 'dev-b', attempts: [{ baseVersion: 1, entity: { ...dto, studentId: 'stu-b' } }] },
        'student',
        'stu-b',
      ),
    ).rejects.toMatchObject({ status: 403 });

    const row = await ds.getRepository(entities.PracticeAttempt).findOneBy({ id: 'att-priv-1' });
    expect(row?.studentId).toBe('stu-a');
  });

  it('上传录音：学员 B 持有 A 的 attempt id 也不能替换其录音', async () => {
    await practice.attachAttemptFile('att-priv-1', Buffer.from('STUDENT-A-WAV'), 'stu-a');
    const before = await practice.readAttemptFile('att-priv-1', 'coach', 'coach1');
    expect(before.data.toString()).toBe('STUDENT-A-WAV');

    await expect(
      practice.attachAttemptFile('att-priv-1', Buffer.from('HACKED-BY-B'), 'stu-b'),
    ).rejects.toMatchObject({ status: 403 });

    const after = await ds.getRepository(entities.PracticeAttempt).findOneBy({ id: 'att-priv-1' });
    const raw = readFileSync(path.join(process.env.UPLOAD_DIR!, after!.filePath!));
    expect(raw.toString('latin1')).not.toContain('HACKED-BY-B');
    const reread = await practice.readAttemptFile('att-priv-1', 'coach', 'coach1');
    expect(reread.data.toString()).toBe('STUDENT-A-WAV');
  });

  it('读取隔离：B 不能读 A 的录音或批注；B 自己的新提交 A 也看不到', async () => {
    await expect(
      practice.readAttemptFile('att-priv-1', 'student', 'stu-b'),
    ).rejects.toMatchObject({ status: 403 });

    await practice.addAnnotation({
      id: 'ann-1', attemptId: 'att-priv-1', coachId: 'coach1',
      atSec: 0.3, comment: '声调可以再上扬', rating: 4,
      version: 1, updatedAt: new Date().toISOString(),
    } as any, 'coach1');

    await expect(
      practice.listAnnotations('att-priv-1', 'student', 'stu-b'),
    ).rejects.toMatchObject({ status: 403 });
    await expect(practice.listAnnotations('att-priv-1', 'student', 'stu-a')).resolves.toHaveLength(1);

    await practice.submitAttempt({
      id: 'att-priv-2', studentId: 'stu-b', courseItemId: 'i1', audioId: 'a2',
      durationSec: 1, waveformPeaks: [0.3], score: null,
      createdAt: new Date().toISOString(), version: 1, updatedAt: new Date().toISOString(),
    } as any, 'stu-b');
    await practice.addAnnotation({
      id: 'ann-2', attemptId: 'att-priv-2', coachId: 'coach1',
      atSec: 0.1, comment: '给 B 的批注', rating: 5,
      version: 1, updatedAt: new Date().toISOString(),
    } as any, 'coach1');

    const aList = await practice.listAttempts('stu-a');
    expect(aList.map((x) => x.id)).toEqual(['att-priv-1']);
    const coachList = await practice.listForCoach();
    expect(coachList.map((x) => x.id).sort()).toEqual(['att-priv-1', 'att-priv-2']);
  });

  it('同步拉取隔离：学员全量 pull 只拿到本人 attempts 及其批注', async () => {
    const pullA = await sync.pull(undefined, 'student', 'stu-a');
    expect(pullA.attempts.map((x) => x.id)).toEqual(['att-priv-1']);
    expect(pullA.attempts.every((x) => x.studentId === 'stu-a')).toBe(true);
    expect(pullA.annotations.map((x) => x.id)).toEqual(['ann-1']);
    expect(pullA.annotations.some((x) => x.comment === '给 B 的批注')).toBe(false);

    const pullB = await sync.pull(undefined, 'student', 'stu-b');
    expect(pullB.attempts.map((x) => x.id)).toEqual(['att-priv-2']);
    expect(pullB.annotations.map((x) => x.id)).toEqual(['ann-2']);

    const pullCoach = await sync.pull(undefined, 'coach', 'coach1');
    expect(pullCoach.attempts.map((x) => x.id).sort()).toEqual(['att-priv-1', 'att-priv-2']);
    expect(pullCoach.annotations.map((x) => x.id).sort()).toEqual(['ann-1', 'ann-2']);
  });

  it('增量同步仍隔离：学员 A 从旧游标只能拉到自己的新数据', async () => {
    const cursor = new Date(Date.now() - 60_000).toISOString();
    const pullA = await sync.pull(cursor, 'student', 'stu-a');
    expect(pullA.attempts.every((x) => x.studentId === 'stu-a')).toBe(true);
    expect(pullA.attempts.some((x) => x.id === 'att-priv-2')).toBe(false);
    expect(pullA.annotations.every((x) => x.id !== 'ann-2')).toBe(true);
  });

  it('同步推送：学员伪造请求体 studentId 无效，落库仍为登录账号', async () => {
    const res = await sync.push(
      {
        deviceId: 'dev-a',
        attempts: [{
          baseVersion: 0,
          entity: {
            id: 'att-priv-3', studentId: 'stu-b' /* 伪造 */, courseItemId: 'i3', audioId: 'a1',
            durationSec: 1, waveformPeaks: [], score: null,
            createdAt: new Date().toISOString(), version: 1, updatedAt: new Date().toISOString(),
          } as any,
        }],
      },
      'student',
      'stu-a',
    );
    expect(res.accepted).toContain('att-priv-3');
    const row = await ds.getRepository(entities.PracticeAttempt).findOneBy({ id: 'att-priv-3' });
    expect(row?.studentId).toBe('stu-a');
  });
});
