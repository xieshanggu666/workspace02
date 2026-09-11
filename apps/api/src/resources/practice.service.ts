import {
  ForbiddenException, Injectable, NotFoundException, OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { mkdir, readFile, writeFile } from 'fs/promises';
import * as path from 'path';
import { PracticeAttempt, Annotation, AudioAsset, Speaker } from '../entities';
import type { AnnotationDto, PracticeAttemptDto } from '@dialect/shared';
import { MapperService } from './mapper.service';

/** 学员练习提交 + 教练批注。学员的跟读录音也加密落盘（个人语音同样敏感）。 */
@Injectable()
export class PracticeService implements OnModuleInit {
  private uploadDir: string;

  constructor(
    @InjectRepository(PracticeAttempt) private readonly attempts: Repository<PracticeAttempt>,
    @InjectRepository(Annotation) private readonly annotations: Repository<Annotation>,
    @InjectRepository(AudioAsset) private readonly assets: Repository<AudioAsset>,
    @InjectRepository(Speaker) private readonly speakers: Repository<Speaker>,
    private readonly mapper: MapperService,
    config: ConfigService,
  ) {
    this.uploadDir = config.get<string>('app.uploadDir')!;
  }

  async onModuleInit() {
    await mkdir(path.join(this.uploadDir, 'attempts'), { recursive: true });
  }

  async listAttempts(studentId?: string): Promise<PracticeAttempt[]> {
    return this.attempts.find({
      where: { deletedAt: IsNull(), ...(studentId ? { studentId } : {}) },
      order: { createdAt: 'DESC' },
    });
  }

  async listForCoach(): Promise<Array<PracticeAttemptDto & { annotations: AnnotationDto[]; title?: string }>> {
    const [attempts, notes, assets] = await Promise.all([
      this.attempts.find({ where: { deletedAt: IsNull() }, order: { createdAt: 'DESC' } }),
      this.annotations.find({ where: { deletedAt: IsNull() } }),
      this.assets.find(),
    ]);
    const titleById = new Map(assets.map((a) => [a.id, a.title]));
    return attempts.map((a) => ({
      ...this.mapper.attempt(a),
      title: titleById.get(a.audioId),
      annotations: notes.filter((n) => n.attemptId === a.id).map((n) => this.mapper.annotation(n)),
    }));
  }

  async getAttemptEntity(id: string) {
    const a = await this.attempts.findOneBy({ id });
    if (!a || a.deletedAt) throw new NotFoundException('练习不存在');
    return a;
  }

  async submitAttempt(dto: PracticeAttemptDto, deviceId?: string): Promise<PracticeAttempt> {
    let a = await this.attempts.findOneBy({ id: dto.id });
    if (!a) {
      a = this.attempts.create({
        id: dto.id,
        createdAt: new Date(dto.createdAt),
        version: Math.max(1, dto.version),
      });
    } else {
      a.version += 1;
    }
    Object.assign(a, {
      studentId: dto.studentId,
      courseItemId: dto.courseItemId,
      audioId: dto.audioId,
      durationSec: dto.durationSec,
      waveformPeaks: dto.waveformPeaks ?? [],
      score: dto.score ?? null,
      filePath: dto.filePath ?? a.filePath ?? null,
      deviceId: deviceId ?? dto.deviceId ?? a.deviceId,
    });
    a.updatedAt = new Date() as any;
    return this.attempts.save(a);
  }

  async attachAttemptFile(id: string, data: Buffer): Promise<PracticeAttempt> {
    const a = await this.getAttemptEntity(id);
    // 学员录音统一加密
    const rel = `attempts/${a.id}.wav.enc`;
    // 与媒体主密钥同域派生（attempt: 前缀区分），此处简单复用 XOR-GCM 包装：
    // 通过 Node crypto 直接 AES-256-GCM
    const { encryptAttempt } = await import('./attempt-crypto');
    await writeFile(path.join(this.uploadDir, rel), encryptAttempt(data, a.id));
    a.filePath = rel;
    a.version += 1;
    a.updatedAt = new Date() as any;
    return this.attempts.save(a);
  }

  async readAttemptFile(
    id: string,
    role: string,
    userId: string,
  ): Promise<{ mime: string; data: Buffer }> {
    const a = await this.getAttemptEntity(id);
    if (role === 'student' && a.studentId !== userId) {
      throw new ForbiddenException('只能读取本人的练习录音');
    }
    if (!a.filePath) throw new NotFoundException('练习录音尚未上传');
    const { decryptAttempt } = await import('./attempt-crypto');
    const data = decryptAttempt(await readFile(path.join(this.uploadDir, a.filePath)), a.id);
    return { mime: 'audio/wav', data };
  }

  async addAnnotation(dto: AnnotationDto, coachId: string, deviceId?: string): Promise<Annotation> {
    await this.getAttemptEntity(dto.attemptId);
    let n = await this.annotations.findOneBy({ id: dto.id });
    if (!n) {
      n = this.annotations.create({ id: dto.id, version: Math.max(1, dto.version) });
    } else {
      n.version += 1;
    }
    Object.assign(n, {
      attemptId: dto.attemptId,
      coachId,
      atSec: dto.atSec,
      comment: dto.comment,
      rating: dto.rating ?? null,
      deviceId: deviceId ?? dto.deviceId ?? n.deviceId,
    });
    n.updatedAt = new Date() as any;
    return this.annotations.save(n);
  }

  async listAnnotations(attemptId: string): Promise<Annotation[]> {
    return this.annotations.find({
      where: { attemptId, deletedAt: IsNull() },
      order: { atSec: 'ASC' },
    });
  }
}
