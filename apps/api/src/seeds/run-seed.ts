import '../ensure-env';
/* eslint-disable no-console */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { mkdir, writeFile } from 'fs/promises';
import * as path from 'path';
import { SAMPLE_SPEAKERS, SAMPLE_AUDIO } from '@dialect/shared';
import { AppModule } from '../app.module';
import { User, Speaker, AudioAsset, Course, CourseItem } from '../entities';
import { MediaCryptoService } from '../media/media-crypto.service';
import { generateWavBuffer } from './generate-wavs';

/**
 * 种子数据：
 *  4 个演示账号 + 6 位说话人（含 granted / pending / revoked 三种授权状态）
 *  + 6 条方言示例音频（敏感的 2 条加密落盘）+ 1 门示例跟读课。
 *
 * 默认账号密码（密码均为 demo1234）：
 *   investigator1 / coach1 / student1 / admin
 */
async function run() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const config = app.get(ConfigService);
  const ds = app.get(DataSource);
  const uploadDir = config.get<string>('app.uploadDir')!;
  const crypto = new MediaCryptoService(config.get<string>('app.masterKeyHex')!);
  await mkdir(path.join(uploadDir, 'audio'), { recursive: true });

  console.log('▶ 清理旧数据…');
  await ds.getRepository(CourseItem).clear();
  await ds.getRepository(Course).clear();
  await ds.getRepository(AudioAsset).clear();
  await ds.getRepository(Speaker).clear();
  await ds.getRepository(User).clear();

  console.log('▶ 创建演示账号…');
  const accounts: Array<Partial<User> & { username: string; role: string }> = [
    { id: 'usr-investigator-01', username: 'investigator1', displayName: '林调查（调查员）', role: 'investigator' },
    { id: 'usr-coach-01', username: 'coach1', displayName: '何教练', role: 'coach' },
    { id: 'usr-student-01', username: 'student1', displayName: '学员小周', role: 'student' },
    { id: 'usr-admin-01', username: 'admin', displayName: '管理员', role: 'admin' },
  ];
  const passwordHash = await bcrypt.hash('demo1234', 10);
  for (const a of accounts) {
    await ds.getRepository(User).save(
      ds.getRepository(User).create({
        ...a,
        passwordHash,
        version: 1,
        deviceId: 'seed',
        updatedAt: new Date(),
        deletedAt: null,
      } as unknown as User),
    );
  }

  console.log('▶ 写入说话人及授权状态…');
  for (const s of SAMPLE_SPEAKERS) {
    await ds.getRepository(Speaker).save(
      ds.getRepository(Speaker).create({
        ...s,
        version: 1,
        deviceId: 'seed',
        updatedAt: new Date(),
        deletedAt: null,
        consentSignedAt: s.consentStatus === 'granted' ? new Date('2026-08-20T03:00:00Z') : null,
      } as unknown as Speaker),
    );
  }

  console.log('▶ 生成 6 条方言示例 WAV（敏感条目加密）…');
  for (const seed of SAMPLE_AUDIO) {
    const { buffer, peaks } = generateWavBuffer(
      seed.syllables,
      seed.asset.durationSec,
      seed.baseFreq,
      seed.asset.sampleRate,
    );
    const sensitive = seed.asset.sensitive;
    const keyVersion = sensitive ? 1 : null;
    const rel = `audio/${seed.asset.id}.${sensitive ? 'wav.enc' : 'wav'}`;
    const payload = sensitive ? crypto.encrypt(buffer, seed.asset.id, 1) : buffer;
    await writeFile(path.join(uploadDir, rel), payload);

    await ds.getRepository(AudioAsset).save(
      ds.getRepository(AudioAsset).create({
        ...seed.asset,
        syllables: seed.syllables,
        waveformPeaks: peaks,
        filePath: rel,
        keyVersion,
        version: 1,
        deviceId: 'seed',
        updatedAt: new Date(),
        deletedAt: null,
        recordedAt: new Date('2026-09-01T02:00:00Z'),
      } as unknown as AudioAsset),
    );
    console.log(`   · ${seed.asset.dialect}  ${seed.asset.title}  ${sensitive ? '[AES-GCM 加密]' : ''}`);
  }

  console.log('▶ 编排示例跟读课《南方方言入门 · 第1课》…');
  const courseId = 'crs-dialect101';
  const lessonAudioIds = ['aud-yue-hello', 'aud-swg-chengdu', 'aud-wu-suzhou', 'aud-nan-xiamen'];
  await ds.getRepository(Course).save(
    ds.getRepository(Course).create({
      id: courseId,
      title: '南方方言入门 · 第1课：打招呼与自我介绍',
      description: '覆盖粤语 / 西南官话 / 吴语 / 闽南语四个问候例句，建议每句跟读 3 遍。',
      coachId: 'usr-coach-01',
      dialect: '多方言',
      published: true,
      itemIds: lessonAudioIds.map((a, i) => `${courseId}-item-${i + 1}`),
      version: 1,
      deviceId: 'seed',
      updatedAt: new Date(),
      deletedAt: null,
    } as unknown as Course),
  );
  const tips = [
    '注意广州话声调上扬，句末语气词要轻。',
    '成都话“我”是舌根鼻音 ŋ 开头，别读成 w。',
    '苏州话保留浊声母，“饭”的声带振动要明显。',
    '厦门话有入声短促韵尾 -t，“日”要收得快。',
  ];
  await lessonAudioIds.reduce<Promise<void>>(async (prev, audioId, i) => {
    await prev;
    await ds.getRepository(CourseItem).save(
      ds.getRepository(CourseItem).create({
        id: `${courseId}-item-${i + 1}`,
        courseId,
        audioId,
        orderIndex: i,
        repeatTimes: 3,
        coachTip: tips[i],
        version: 1,
        deviceId: 'seed',
        updatedAt: new Date(),
        deletedAt: null,
      } as unknown as CourseItem),
    );
  }, Promise.resolve());

  console.log('\n✅ 种子完成。登录密码统一为 demo1234');
  console.log('   investigator1（调查员） / coach1（教练） / student1（学员） / admin');
  await app.close();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
