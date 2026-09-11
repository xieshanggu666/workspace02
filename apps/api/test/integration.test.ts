import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { writeFile } from 'fs/promises';
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
const { ConsentEnforcementService } = await import('../src/resources/consent-enforcement.service');
const { SyncService } = await import('../src/sync/sync.service');
const entities = await import('../src/entities');

describe('端到端（sql.js）：授权闸门 / 加密媒体 / 离线同步 / 练习隐私', () => {
  let app: any;
  let ds: DataSource;
  let speakers: SpeakersService;
  let audio: AudioService;
  let courses: CoursesService;
  let practice: PracticeService;
  let enforcement: ConsentEnforcementService;
  let sync: SyncService;

  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await app.init();
    ds = app.get(DataSource);
    speakers = app.get(SpeakersService);
    audio = app.get(AudioService);
    courses = app.get(CoursesService);
    practice = app.get(PracticeService);
    enforcement = app.get(ConsentEnforcementService);
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
      scope: 'course',
      agreementText: '本人同意录音用于方言研究与跟读课程。',
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
    // 撤回后文件已封口加密：调查员经内存解密仍能读到原文
    expect((await audio.readMedia('a2', 'investigator')).data.toString()).toBe('RIFFxxxxWAVE-public');
  });

  it('撤回授权会真正把明文文件封口为 AES-GCM 密文并删除明文', async () => {
    // 新说话人 + course 授权 + 明文素材
    await speakers.upsert({
      id: 's-seal', code: 'SEAL-1', name: '封口测试', dialect: '粤语', region: '广州',
      consentStatus: 'granted', consentScope: 'course', version: 1, updatedAt: new Date().toISOString(),
    } as any);
    await audio.upsert({
      id: 'a-seal', title: '待封口录音', speakerId: 's-seal', ownerId: 'u1', dialect: '粤语',
      durationSec: 0.1, sampleRate: 16000, channels: 1, mime: 'audio/wav',
      waveformPeaks: [0.3], syllables: [{ start: 0, end: 0.1, label: 'x' }],
      transcript: '你好', status: 'annotated', sensitive: false,
      recordedAt: new Date().toISOString(), version: 1, updatedAt: new Date().toISOString(),
    } as any);
    const PLAIN = Buffer.from('RIFF-seal-me-plaintext-audio');
    await audio.attachFile('a-seal', PLAIN);

    let row = await ds.getRepository(entities.AudioAsset).findOneBy({ id: 'a-seal' });
    expect(row!.filePath).toBe('audio/a-seal.wav');
    expect(row!.keyVersion).toBeNull();
    const plainOnDisk = readFileSync(path.join(process.env.UPLOAD_DIR!, row!.filePath!));
    expect(plainOnDisk.toString()).toBe('RIFF-seal-me-plaintext-audio');

    // 撤回：返回封口数量，元数据状态与文件都应变化
    const res = await speakers.revokeConsent('s-seal');
    expect(res.sealed).toBe(1);
    row = await ds.getRepository(entities.AudioAsset).findOneBy({ id: 'a-seal' });
    // sensitive 是素材自身的显式标记，不由授权状态改写；撤回体现为 status=restricted
    expect(row!.status).toBe('restricted');
    expect(row!.keyVersion).toBe(1);
    expect(row!.filePath).toBe('audio/a-seal.wav.enc');

    // 明文文件已删除，只剩密文；密文不含明文内容
    const encPath = path.join(process.env.UPLOAD_DIR!, row!.filePath!);
    expect(existsSync(encPath)).toBe(true);
    expect(existsSync(path.join(process.env.UPLOAD_DIR!, 'audio/a-seal.wav'))).toBe(false);
    const encOnDisk = readFileSync(encPath);
    expect(encOnDisk.toString('latin1')).not.toContain('RIFF-seal-me-plaintext-audio');
    // 密文不是明文（已加密）
    expect(encOnDisk.subarray(0, 4).toString('latin1')).not.toBe('RIFF');

    // 调查员经授权 + 解密仍可还原
    const back = await audio.readMedia('a-seal', 'investigator');
    expect(back.data.equals(PLAIN)).toBe(true);
    // 学员/教练 403
    await expect(audio.readMedia('a-seal', 'student')).rejects.toMatchObject({ status: 403 });
    await expect(audio.readMedia('a-seal', 'coach')).rejects.toMatchObject({ status: 403 });
  });

  it('同步推送撤回同样触发封口；重新授予 course 后恢复可分发（文件保留加密）', async () => {
    // 同步通道撤回 s-seal（已在上一用例撤回，这里新建独立素材验证 sync 触发）
    await speakers.upsert({
      id: 's-syncseal', code: 'SYNCSEAL', name: '同步封口', dialect: '粤语', region: '广州',
      consentStatus: 'granted', consentScope: 'course', version: 1, updatedAt: new Date().toISOString(),
    } as any);
    await audio.upsert({
      id: 'a-syncseal', title: '同步待封口', speakerId: 's-syncseal', ownerId: 'u1', dialect: '粤语',
      durationSec: 0.1, sampleRate: 16000, channels: 1, mime: 'audio/wav',
      waveformPeaks: [0.3], syllables: [], status: 'annotated', sensitive: false,
      recordedAt: new Date().toISOString(), version: 1, updatedAt: new Date().toISOString(),
    } as any);
    await audio.attachFile('a-syncseal', Buffer.from('RIFF-sync-plain'));

    // 通过 sync push 撤回
    const pushRes = await sync.push(
      { deviceId: 'd', speakers: [{ baseVersion: 1, entity: {
        id: 's-syncseal', code: 'SYNCSEAL', name: '同步封口', dialect: '粤语', region: '广州',
        consentStatus: 'revoked', consentScope: null, version: 2,
        updatedAt: new Date(Date.now() + 1000).toISOString(),
      } as any }] },
      'investigator', 'u1',
    );
    expect(pushRes.accepted).toContain('s-syncseal');
    const row = await ds.getRepository(entities.AudioAsset).findOneBy({ id: 'a-syncseal' });
    expect(row!.filePath).toBe('audio/a-syncseal.wav.enc');
    expect(row!.keyVersion).toBe(1);
    expect(existsSync(path.join(process.env.UPLOAD_DIR!, 'audio/a-syncseal.wav'))).toBe(false);

    // 重新授予 course：恢复可分发，文件仍加密
    await speakers.grantConsent('s-syncseal', { scope: 'course', agreementText: '重新同意课程用途' });
    const row2 = await ds.getRepository(entities.AudioAsset).findOneBy({ id: 'a-syncseal' });
    expect(row2!.status).not.toBe('restricted');
    expect(row2!.keyVersion).toBe(1); // 仍加密
    const back = await audio.readMedia('a-syncseal', 'student');
    expect(back.data.toString()).toBe('RIFF-sync-plain');
  });

  it('【回归】给一开始就是 research 的说话人录音，上传瞬间即为密文，磁盘无明文窗口', async () => {
    await speakers.upsert({
      id: 's-research-upload', code: 'RESU', name: '仅研究', dialect: '西南官话', region: '成都',
      consentStatus: 'granted', consentScope: 'research', version: 1, updatedAt: new Date().toISOString(),
    } as any);
    await audio.upsert({
      id: 'a-research-upload', title: '研究录音', speakerId: 's-research-upload', ownerId: 'u1',
      dialect: '西南官话', durationSec: 0.1, sampleRate: 16000, channels: 1, mime: 'audio/wav',
      waveformPeaks: [0.2], syllables: [], status: 'annotated', sensitive: false,
      recordedAt: new Date().toISOString(), version: 1, updatedAt: new Date().toISOString(),
    } as any);
    await audio.attachFile('a-research-upload', Buffer.from('RIFF-NEW-RESEARCH-AUDIO'));

    // 从未发生授权状态迁移，但文件必须在写入瞬间就是密文
    const row = await ds.getRepository(entities.AudioAsset).findOneBy({ id: 'a-research-upload' });
    expect(row!.filePath).toBe('audio/a-research-upload.wav.enc');
    expect(row!.keyVersion).toBe(1);
    expect(existsSync(path.join(process.env.UPLOAD_DIR!, 'audio/a-research-upload.wav'))).toBe(false);
    const onDisk = readFileSync(path.join(process.env.UPLOAD_DIR!, row!.filePath!));
    expect(onDisk.toString('latin1')).not.toContain('RIFF-NEW-RESEARCH-AUDIO');
    expect(onDisk.subarray(0, 4).toString('latin1')).not.toBe('RIFF');

    // pending / revoked 说话人同样上传即密文
    await speakers.upsert({
      id: 's-pending-upload', code: 'PEND', name: '待签', dialect: '客家话', region: '梅州',
      consentStatus: 'pending', consentScope: null, version: 1, updatedAt: new Date().toISOString(),
    } as any);
    await audio.upsert({
      id: 'a-pending-upload', title: '待授权录音', speakerId: 's-pending-upload', ownerId: 'u1',
      dialect: '客家话', durationSec: 0.1, sampleRate: 16000, channels: 1, mime: 'audio/mp4',
      waveformPeaks: [0.2], syllables: [], status: 'draft', sensitive: false,
      recordedAt: new Date().toISOString(), version: 1, updatedAt: new Date().toISOString(),
    } as any);
    await audio.attachFile('a-pending-upload', Buffer.from('ftypM4A-pending'), 'audio/mp4');
    const prow = await ds.getRepository(entities.AudioAsset).findOneBy({ id: 'a-pending-upload' });
    expect(prow!.filePath).toBe('audio/a-pending-upload.m4a.enc');

    // course 授权说话人新录音仍为明文（分发允许，静态加密非必须）
    await speakers.upsert({
      id: 's-course-upload', code: 'COURSEUP', name: '课程授权', dialect: '粤语', region: '广州',
      consentStatus: 'granted', consentScope: 'course', version: 1, updatedAt: new Date().toISOString(),
    } as any);
    await audio.upsert({
      id: 'a-course-upload', title: '课程录音', speakerId: 's-course-upload', ownerId: 'u1',
      dialect: '粤语', durationSec: 0.1, sampleRate: 16000, channels: 1, mime: 'audio/wav',
      waveformPeaks: [0.2], syllables: [], status: 'annotated', sensitive: false,
      recordedAt: new Date().toISOString(), version: 1, updatedAt: new Date().toISOString(),
    } as any);
    await audio.attachFile('a-course-upload', Buffer.from('RIFF-COURSE-OK'));
    const crow = await ds.getRepository(entities.AudioAsset).findOneBy({ id: 'a-course-upload' });
    expect(crow!.filePath).toBe('audio/a-course-upload.wav');
    expect(crow!.keyVersion).toBeNull();

    // 调查员经内存解密可正常播放 research 录音
    const back = await audio.readMedia('a-research-upload', 'investigator');
    expect(back.data.toString()).toBe('RIFF-NEW-RESEARCH-AUDIO');
  });

  it('【回归】历史遗留的 research 明文素材在启动自愈扫描时被封口', async () => {
    // 直接构造一条“旧版本遗留”：research 授权但 keyVersion=null、filePath 指向明文
    await speakers.upsert({
      id: 's-legacy', code: 'LEG', name: '历史仅研究', dialect: '粤语', region: '广州',
      consentStatus: 'granted', consentScope: 'research', version: 1, updatedAt: new Date().toISOString(),
    } as any);
    await audio.upsert({
      id: 'a-legacy', title: '历史明文', speakerId: 's-legacy', ownerId: 'u1',
      dialect: '粤语', durationSec: 0.1, sampleRate: 16000, channels: 1, mime: 'audio/wav',
      waveformPeaks: [0.2], syllables: [], status: 'annotated', sensitive: false,
      recordedAt: new Date().toISOString(), version: 1, updatedAt: new Date().toISOString(),
    } as any);
    // 绕过 attachFile，直接写明文文件 + 元数据（模拟历史数据）
    await writeFile(path.join(process.env.UPLOAD_DIR!, 'audio/a-legacy.wav'), Buffer.from('RIFF-LEGACY-PLAIN'));
    await ds.getRepository(entities.AudioAsset).update('a-legacy', { filePath: 'audio/a-legacy.wav', keyVersion: null } as any);
    expect(existsSync(path.join(process.env.UPLOAD_DIR!, 'audio/a-legacy.wav'))).toBe(true);

    const enforcement = app.get(ConsentEnforcementService);
    const sealed = await enforcement.reconcileAllAssets();
    expect(sealed).toBeGreaterThanOrEqual(1);
    const row = await ds.getRepository(entities.AudioAsset).findOneBy({ id: 'a-legacy' });
    expect(row!.filePath).toBe('audio/a-legacy.wav.enc');
    expect(row!.keyVersion).toBe(1);
    expect(existsSync(path.join(process.env.UPLOAD_DIR!, 'audio/a-legacy.wav'))).toBe(false);
    // 幂等：再扫一次不再封口
    expect(await enforcement.reconcileAllAssets()).toBe(0);
  });

  it('【回归】通用 upsert 把授权改为 revoked/research 时，名下明文录音必须封口', async () => {
    // course 授权说话人 + 明文素材
    await speakers.upsert({
      id: 's-upseal', code: 'UPSEAL', name: '通用更新封口', dialect: '粤语', region: '广州',
      consentStatus: 'granted', consentScope: 'course', version: 1, updatedAt: new Date().toISOString(),
    } as any);
    await audio.upsert({
      id: 'a-upseal', title: '明文素材', speakerId: 's-upseal', ownerId: 'u1', dialect: '粤语',
      durationSec: 0.1, sampleRate: 16000, channels: 1, mime: 'audio/wav',
      waveformPeaks: [0.2], syllables: [], status: 'annotated', sensitive: false,
      recordedAt: new Date().toISOString(), version: 1, updatedAt: new Date().toISOString(),
    } as any);
    await audio.attachFile('a-upseal', Buffer.from('RIFF-UPSERT-PLAIN'));
    expect(existsSync(path.join(process.env.UPLOAD_DIR!, 'audio/a-upseal.wav'))).toBe(true);

    // 攻击/误用：通过通用更新接口直接改成 revoked（绕过 /revoke 端点）
    await speakers.upsert({
      id: 's-upseal', code: 'UPSEAL', name: '通用更新封口', dialect: '粤语', region: '广州',
      consentStatus: 'revoked', consentScope: null, version: 2, updatedAt: new Date().toISOString(),
    } as any);

    let row = await ds.getRepository(entities.AudioAsset).findOneBy({ id: 'a-upseal' });
    expect(row!.filePath).toBe('audio/a-upseal.wav.enc');
    expect(row!.keyVersion).toBe(1);
    expect(existsSync(path.join(process.env.UPLOAD_DIR!, 'audio/a-upseal.wav'))).toBe(false);

    // 同一通道把 scope 缩减为 research（先恢复到 course 再改 research）
    await speakers.upsert({
      id: 's-upseal', code: 'UPSEAL', name: '通用更新封口', dialect: '粤语', region: '广州',
      consentStatus: 'granted', consentScope: 'course', version: 3, updatedAt: new Date().toISOString(),
    } as any);
    // 放一条新明文素材，验证 course→research 经通用接口也封口
    await audio.upsert({
      id: 'a-upseal2', title: '第二条明文', speakerId: 's-upseal', ownerId: 'u1', dialect: '粤语',
      durationSec: 0.1, sampleRate: 16000, channels: 1, mime: 'audio/wav',
      waveformPeaks: [0.2], syllables: [], status: 'annotated', sensitive: false,
      recordedAt: new Date().toISOString(), version: 1, updatedAt: new Date().toISOString(),
    } as any);
    await audio.attachFile('a-upseal2', Buffer.from('RIFF-UPSERT2-PLAIN'));

    await speakers.upsert({
      id: 's-upseal', code: 'UPSEAL', name: '通用更新封口', dialect: '粤语', region: '广州',
      consentStatus: 'granted', consentScope: 'research', version: 4, updatedAt: new Date().toISOString(),
    } as any);

    row = await ds.getRepository(entities.AudioAsset).findOneBy({ id: 'a-upseal2' });
    expect(row!.filePath).toBe('audio/a-upseal2.wav.enc');
    expect(row!.keyVersion).toBe(1);
    // research 保留 annotated 状态（分发由授权策略过滤，不是 status）
    expect(row!.status).toBe('annotated');
    expect(existsSync(path.join(process.env.UPLOAD_DIR!, 'audio/a-upseal2.wav'))).toBe(false);

    // 恢复 course：重新可分发（文件保留加密）
    await speakers.upsert({
      id: 's-upseal', code: 'UPSEAL', name: '通用更新封口', dialect: '粤语', region: '广州',
      consentStatus: 'granted', consentScope: 'course', version: 5, updatedAt: new Date().toISOString(),
    } as any);
    const restored = await audio.readMedia('a-upseal2', 'student');
    expect(restored.data.toString()).toBe('RIFF-UPSERT2-PLAIN');
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
    // 课程只能引用 course/public 授权素材：新建合规说话人与两条素材
    await speakers.upsert({
      id: 's4', code: 'T-4', name: '课程授权发音人', dialect: '粤语', region: '广州',
      consentStatus: 'granted', consentScope: 'course', version: 1, updatedAt: new Date().toISOString(),
    } as any);
    await speakers.upsert({
      id: 's5', code: 'T-5', name: '公开授权发音人', dialect: '粤语', region: '佛山',
      consentStatus: 'granted', consentScope: 'public', version: 1, updatedAt: new Date().toISOString(),
    } as any);
    await audio.upsert({
      id: 'a4', title: '可入课素材1', speakerId: 's4', ownerId: 'u1', dialect: '粤语',
      durationSec: 0.1, sampleRate: 16000, channels: 1, mime: 'audio/wav',
      waveformPeaks: [0.2], syllables: [], status: 'annotated', sensitive: false,
      recordedAt: new Date().toISOString(), version: 1, updatedAt: new Date().toISOString(),
    } as any);
    await audio.upsert({
      id: 'a5', title: '可入课素材2', speakerId: 's5', ownerId: 'u1', dialect: '粤语',
      durationSec: 0.1, sampleRate: 16000, channels: 1, mime: 'audio/wav',
      waveformPeaks: [0.2], syllables: [], status: 'annotated', sensitive: false,
      recordedAt: new Date().toISOString(), version: 1, updatedAt: new Date().toISOString(),
    } as any);

    const dto = {
      id: 'c1', title: '测试课', coachId: 'u1', dialect: '粤语', published: false,
      version: 1, updatedAt: new Date().toISOString(),
      items: [
        { id: 'i1', courseId: 'c1', audioId: 'a4', orderIndex: 0, repeatTimes: 2, version: 1, updatedAt: new Date().toISOString() },
        { id: 'i2', courseId: 'c1', audioId: 'a5', orderIndex: 1, repeatTimes: 4, version: 1, updatedAt: new Date().toISOString() },
      ],
    } as any;
    await courses.saveCourse(dto);
    let saved = await courses.getDto('c1');
    expect(saved.items.map((i) => i.id)).toEqual(['i1', 'i2']);

    await courses.saveCourse({
      ...dto,
      items: [
        { ...dto.items[0] },
        { id: 'i3', courseId: 'c1', audioId: 'a5', orderIndex: 1, repeatTimes: 1, version: 1, updatedAt: new Date().toISOString() },
      ],
    });
    saved = await courses.getDto('c1');
    expect(saved.items.map((i) => i.id)).toEqual(['i1', 'i3']);

    const stale = await ds.getRepository(entities.CourseItem).findOneBy({ id: 'i2' });
    expect(stale?.deletedAt).not.toBeNull();
  });

  // ============ 知情同意范围（consent scope）强制 ============

  it('research 授权素材：学员/教练不能下载、列表与同步都不出现', async () => {
    await speakers.upsert({
      id: 's6', code: 'T-6', name: '仅研究授权', dialect: '西南官话', region: '成都',
      consentStatus: 'granted', consentScope: 'research', version: 1, updatedAt: new Date().toISOString(),
    } as any);
    await audio.upsert({
      id: 'a6', title: '仅限研究的录音', speakerId: 's6', ownerId: 'u1', dialect: '西南官话',
      durationSec: 0.1, sampleRate: 16000, channels: 1, mime: 'audio/wav',
      waveformPeaks: [0.2], syllables: [], status: 'annotated', sensitive: false,
      recordedAt: new Date().toISOString(), version: 1, updatedAt: new Date().toISOString(),
    } as any);
    await audio.attachFile('a6', Buffer.from('RIFF-research-only'));

    await expect(audio.readMedia('a6', 'student')).rejects.toMatchObject({ status: 403 });
    await expect(audio.readMedia('a6', 'coach')).rejects.toMatchObject({ status: 403 });
    expect((await audio.readMedia('a6', 'investigator')).data.toString()).toBe('RIFF-research-only');

    expect((await audio.list({ role: 'coach' })).some((x) => x.id === 'a6')).toBe(false);
    expect((await audio.list({ role: 'student' })).some((x) => x.id === 'a6')).toBe(false);
    expect((await audio.list({ role: 'investigator' })).some((x) => x.id === 'a6')).toBe(true);

    const coachPull = await sync.pull(undefined, 'coach', 'coach1');
    expect(coachPull.audio.some((x) => x.id === 'a6')).toBe(false);
    const stuPull = await sync.pull(undefined, 'student', 'stu-a');
    expect(stuPull.audio.some((x) => x.id === 'a6')).toBe(false);
    const staffPull = await sync.pull(undefined, 'investigator', 'u1');
    expect(staffPull.audio.some((x) => x.id === 'a6')).toBe(true);

    // 单条元数据同样挡：教练/学员拿 research 素材详情返回 403
    await expect(audio.getDto('a6', 'student')).rejects.toMatchObject({ status: 403 });
    await expect(audio.getDto('a6', 'coach')).rejects.toMatchObject({ status: 403 });
    expect((await audio.getDto('a6', 'investigator')).id).toBe('a6');
  });

  it('research 素材不能被编入课程（REST 与 sync push 双通道拒绝）', async () => {
    await expect(
      courses.saveCourse({
        id: 'c-bad', title: '违规课程', coachId: 'coach1', dialect: '西南官话', published: true,
        version: 1, updatedAt: new Date().toISOString(),
        items: [
          { id: 'bad-i1', courseId: 'c-bad', audioId: 'a6', orderIndex: 0, repeatTimes: 3, version: 1, updatedAt: new Date().toISOString() },
        ],
      } as any),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      sync.push(
        {
          deviceId: 'coach-dev',
          courses: [{ baseVersion: 0, entity: {
            id: 'c-bad', title: '违规课程', coachId: 'coach1', dialect: '西南官话',
            published: true, version: 1, updatedAt: new Date().toISOString(),
          } as any }],
          courseItems: [{ baseVersion: 0, entity: {
            id: 'bad-i1', courseId: 'c-bad', audioId: 'a6', orderIndex: 0,
            repeatTimes: 3, version: 1, updatedAt: new Date().toISOString(),
          } as any }],
        },
        'coach',
        'coach1',
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(await ds.getRepository(entities.Course).findOneBy({ id: 'c-bad' })).toBeNull();
  });

  it('学员视角：含 research 素材的课程在列表/详情/同步课目中都被过滤', async () => {
    // 混合课程：一句 research(a6) + 一句 course(a4)
    // 绕过校验直接插库，模拟历史脏数据
    await ds.getRepository(entities.Course).save(
      ds.getRepository(entities.Course).create({
        id: 'c-mixed', title: '混合课', coachId: 'coach1', dialect: '多方言',
        published: true, itemIds: ['mix-i-research', 'mix-i-ok'],
        version: 1, updatedAt: new Date(), deletedAt: null,
      } as any),
    );
    await ds.getRepository(entities.CourseItem).save([
      ds.getRepository(entities.CourseItem).create({
        id: 'mix-i-research', courseId: 'c-mixed', audioId: 'a6', orderIndex: 0,
        repeatTimes: 3, version: 1, updatedAt: new Date(), deletedAt: null,
      } as any),
      ds.getRepository(entities.CourseItem).create({
        id: 'mix-i-ok', courseId: 'c-mixed', audioId: 'a4', orderIndex: 1,
        repeatTimes: 3, version: 1, updatedAt: new Date(), deletedAt: null,
      } as any),
    ]);

    // 学员列表保留该课但只剩合规课目
    const list = await courses.list(true, 'student');
    const mixed = list.find((c) => c.id === 'c-mixed');
    expect(mixed?.items.map((i) => i.audioId)).toEqual(['a4']);

    // 学员详情同样过滤
    const detail = await courses.getDtoForStudent('c-mixed');
    expect(detail.items.some((i) => i.audioId === 'a6')).toBe(false);

    // 同步课目不含 research 引用
    const stuPull = await sync.pull(undefined, 'student', 'stu-a');
    expect(stuPull.courseItems.some((i) => i.audioId === 'a6')).toBe(false);
    expect(stuPull.courseItems.some((i) => i.audioId === 'a4')).toBe(true);

    // 教练视角不受此过滤
    const coachList = await courses.list(true, 'coach');
    const coachMixed = coachList.find((c) => c.id === 'c-mixed');
    expect(coachMixed?.items.length).toBe(2);
  });

  // ============ 路径穿越 / 密钥文件读取防护 ============

  it('教练不能通过 PUT 元数据注入 filePath 读取 .env / 源码 / 密钥', async () => {
    // a4 是 course 授权的合规素材，教练可读
    await audio.attachFile('a4', Buffer.from('RIFF-legit-course-audio'));

    // 攻击 1：教练直接调用 upsert 时携带 filePath（模拟 PUT /audio/a4 body）
    await audio.upsert(
      {
        ...(await audio.getDto('a4')),
        filePath: '../../.env',
        keyVersion: null,
      },
      'dev-coach',
      { role: 'coach', userId: 'coach1' },
    );
    let entity = await audio.getEntity('a4');
    // filePath 不被客户端输入改写
    expect(entity.filePath).toMatch(/^audio\/a4\.(wav|m4a)$/);
    expect(entity.keyVersion).toBeNull(); // 本来就是非敏感
    // 读出来仍然是原始录音，而不是 .env
    expect((await audio.readMedia('a4', 'coach')).data.toString()).toBe('RIFF-legit-course-audio');

    // 攻击 2：尝试绝对路径 /etc/passwd
    await audio.upsert(
      { ...(await audio.getDto('a4')), filePath: '/etc/passwd', keyVersion: null },
      'dev-coach',
      { role: 'coach', userId: 'coach1' },
    );
    entity = await audio.getEntity('a4');
    expect(entity.filePath).toMatch(/^audio\//);
    await expect(
      audio.readMedia({} as any, 'coach'),
    ).rejects.toBeTruthy();

    // 攻击 3：教练试图把素材改成非敏感再换路径
    await audio.upsert(
      { ...(await audio.getDto('a4')), sensitive: false, filePath: 'attempts/../../package.json' },
      'dev-coach',
      { role: 'coach', userId: 'coach1' },
    );
    entity = await audio.getEntity('a4');
    expect(entity.filePath).toMatch(/^audio\//);
  });

  it('即使 DB 里被直接写入穿越路径，读取守卫也拒绝越界', async () => {
    // 模拟最极端情况：绕过应用层直接改库
    await ds.getRepository(entities.AudioAsset).update('a4', {
      filePath: '../../../../../../etc/passwd',
      keyVersion: null,
    } as any);
    await expect(audio.readMedia('a4', 'investigator')).rejects.toThrow(/非法媒体路径|媒体路径越界/);
  });

  it('教练不能把已受限素材降级为公开', async () => {
    // a1 是 sensitive/restricted；教练显式以 coach 身份尝试降级
    const res = await audio.upsert(
      { ...(await audio.getDto('a1')), sensitive: false, status: 'published' },
      'dev-coach',
      { role: 'coach', userId: 'coach1' },
    );
    expect(res.sensitive).toBe(true);
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

  it('Android m4a/AAC 跟读：按真实 MIME 存盘，读回的 Content-Type 不是 wav', async () => {
    const id = 'att-mime-1';
    await practice.submitAttempt({
      id, studentId: 'stu-a', courseItemId: 'i1', audioId: 'a2',
      durationSec: 0.8, mime: 'audio/mp4', waveformPeaks: [0.2], score: null,
      createdAt: new Date().toISOString(), version: 1, updatedAt: new Date().toISOString(),
    } as any, 'stu-a');
    await practice.attachAttemptFile(id, Buffer.from('ftypM4A-binary-aac'), 'stu-a', 'audio/mp4');

    const row = await ds.getRepository(entities.PracticeAttempt).findOneBy({ id });
    expect(row?.filePath).toBe(`attempts/${id}.m4a.enc`);
    expect(row?.mime).toBe('audio/mp4');

    const back = await practice.readAttemptFile(id, 'stu-a', 'stu-a');
    expect(back.mime).toBe('audio/mp4');
    expect(back.data.toString()).toBe('ftypM4A-binary-aac');
  });

  // ============ 时间戳 / 同步游标毒化防护 ============

  it('未来 updatedAt 被钳制，且无法把全服同步游标推到未来', async () => {
    // 学员推送一条 2999 年的 attempt
    await sync.push(
      {
        deviceId: 'evil-clock',
        attempts: [{
          baseVersion: 0,
          entity: {
            id: 'att-future-1', studentId: 'stu-a', courseItemId: 'i1', audioId: 'a2',
            durationSec: 1, waveformPeaks: [], score: null,
            createdAt: '2999-01-01T00:00:00.000Z',
            version: 1, updatedAt: '2999-01-01T00:00:00.000Z',
          } as any,
        }],
      },
      'student',
      'stu-a',
    );

    const row = await ds.getRepository(entities.PracticeAttempt).findOneBy({ id: 'att-future-1' });
    // 业务/编辑时间被钳到 now+5min 附近，绝不是 2999 年
    expect(new Date(row!.updatedAt).getUTCFullYear()).toBeLessThan(2999);
    expect(new Date(row!.updatedAt).getTime()).toBeLessThan(Date.now() + 6 * 60_000);
    // serverUpdatedAt 是服务器时钟（今年）
    expect(new Date((row as any).serverUpdatedAt).getUTCFullYear()).toBe(new Date().getUTCFullYear());

    // 全量游标不能跳到未来：应为服务器当前时间量级
    const pull = await sync.pull(undefined, 'student', 'stu-a');
    const cursorMs = Date.parse(pull.cursor);
    expect(cursorMs).toBeLessThan(Date.now() + 60_000);
    expect(cursorMs).toBeGreaterThan(Date.now() - 3_600_000);

    // 关键：毒记录之后，其他学员仍能用「毒记录之前」的旧游标增量拉到它（拉取不空）
    const oldCursor = new Date(Date.now() - 60_000).toISOString();
    const lateStudent = await sync.pull(oldCursor, 'student', 'stu-a');
    expect(lateStudent.attempts.some((a) => a.id === 'att-future-1')).toBe(true);

    // 毒记录之后再产生的正常数据，同样能被「毒记录之前」的游标拉到（系统未坏）
    await new Promise((r) => setTimeout(r, 5));
    await sync.push(
      { deviceId: 'normal', attempts: [{ baseVersion: 0, entity: {
        id: 'att-after-poison', studentId: 'stu-a', courseItemId: 'i1', audioId: 'a2',
        durationSec: 1, waveformPeaks: [], score: null,
        createdAt: new Date().toISOString(), version: 1, updatedAt: new Date().toISOString(),
      } as any }] },
      'student', 'stu-a',
    );
    const pullAgain = await sync.pull(oldCursor, 'student', 'stu-a');
    expect(pullAgain.attempts.some((a) => a.id === 'att-after-poison')).toBe(true);
  });

  it('已中毒的游标（2999年）在 pull 时被钳到服务器当前，设备自愈', async () => {
    // 先放一条正常数据
    await speakers.upsert({
      id: 's-cursor', code: 'C-X', name: '游标测试', dialect: '粤语', region: '广州',
      consentStatus: 'granted', consentScope: 'course', version: 1,
      updatedAt: new Date().toISOString(),
    } as any);
    // 客户端带着未来游标来拉
    const poisoned = '2999-01-01T00:00:00.000Z';
    const healed = await sync.pull(poisoned, 'investigator', 'u1');
    const cursorMs = Date.parse(healed.cursor);
    expect(cursorMs).toBeLessThan(Date.now() + 6 * 60_000);
    expect(cursorMs).toBeGreaterThan(Date.now() - 3_600_000);
    // 返回的游标不晚于服务器时钟
    expect(cursorMs).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
  });

  it('LWW：未来时间戳的记录不会永远压过后续合法编辑', async () => {
    // 同一条记录，第一次用未来时间推，再用正常（更晚的真实）时间改
    await sync.push(
      { deviceId: 'd1', speakers: [{ baseVersion: 0, entity: {
        id: 's-lww', code: 'LWW-1', name: '未来版', dialect: '粤语', region: '广州',
        consentStatus: 'granted', consentScope: 'course', version: 1,
        updatedAt: '2999-01-01T00:00:00Z',
      } as any }] },
      'investigator', 'u1',
    );
    // 另一设备基于服务端版本用正常时间再改（时间更晚于被钳制后的时间）
    const row = await ds.getRepository(entities.Speaker).findOneBy({ id: 's-lww' });
    await new Promise((r) => setTimeout(r, 5));
    const res = await sync.push(
      { deviceId: 'd2', speakers: [{ baseVersion: 1, entity: {
        id: 's-lww', code: 'LWW-1', name: '合法新版', dialect: '粤语', region: '广州',
        consentStatus: 'granted', consentScope: 'course', version: 2,
        updatedAt: new Date(Date.now() + 10_000).toISOString(),
      } as any }] },
      'investigator', 'u1',
    );
    expect(res.accepted).toContain('s-lww');
    const final = await ds.getRepository(entities.Speaker).findOneBy({ id: 's-lww' });
    expect(final!.name).toBe('合法新版');
    expect(row!.updatedAt).toBeTruthy();
  });
});
