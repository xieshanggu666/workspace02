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
import { sanitizeClientTime } from '@dialect/shared';
import { MapperService } from './mapper.service';
import { resolveWithinStorage } from '../media/path-guard';

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

  /**
   * 学员提交跟读。
   * 安全：以登录身份 studentId 为唯一归属来源（忽略请求体里的 studentId），
   * 且已有记录若非本人所有一律 403，杜绝冒名提交或覆盖他人记录。
   */
  async submitAttempt(
    dto: PracticeAttemptDto,
    studentId: string,
    deviceId?: string,
  ): Promise<PracticeAttempt> {
    let a = await this.attempts.findOneBy({ id: dto.id });
    if (a && a.studentId !== studentId) {
      throw new ForbiddenException('不能修改其他学员的练习记录');
    }
    if (!a) {
      a = this.attempts.create({
        id: dto.id,
        createdAt: sanitizeClientTime(dto.createdAt),
        version: Math.max(1, dto.version),
      });
    } else {
      a.version += 1;
    }
    Object.assign(a, {
      studentId,
      courseItemId: dto.courseItemId,
      audioId: dto.audioId,
      durationSec: dto.durationSec,
      mime: dto.mime || a.mime || 'audio/wav',
      waveformPeaks: dto.waveformPeaks ?? [],
      score: dto.score ?? null,
      filePath: a.filePath ?? null,
      deviceId: deviceId ?? dto.deviceId ?? a.deviceId,
    });
    a.updatedAt = new Date() as any;
    return this.attempts.save(a);
  }

  /**
   * 上传跟读录音二进制。
   * 安全：学员只能给本人名下的 attempt 上传；教练/管理员不代传。
   * 文件始终 AES-256-GCM 加密落盘，重复上传即覆盖本人文件（合法的重录场景）。
   * 扩展名按真实格式（iOS wav / Android m4a），下载时回传对应 Content-Type。
   */
  async attachAttemptFile(
    id: string,
    data: Buffer,
    studentId: string,
    mime = 'audio/wav',
  ): Promise<PracticeAttempt> {
    const a = await this.getAttemptEntity(id);
    if (a.studentId !== studentId) {
      throw new ForbiddenException('不能替换其他学员的练习录音');
    }
    const ext = mime === 'audio/mp4' || mime === 'audio/m4a' || mime === 'audio/aac'
      ? 'm4a'
      : 'wav';
    const rel = `attempts/${a.id}.${ext}.enc`;
    const { encryptAttempt } = await import('./attempt-crypto');
    await writeFile(resolveWithinStorage(this.uploadDir, rel), encryptAttempt(data, a.id));
    a.filePath = rel;
    a.mime = mime;
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
    // 纵深防御：即使 filePath 被污染也只能落在 attempts/ 存储目录内
    const data = decryptAttempt(
      await readFile(resolveWithinStorage(this.uploadDir, a.filePath)),
      a.id,
    );
    return { mime: a.mime || 'audio/wav', data };
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

  /**
   * 批注列表访问控制：
   *  - 教练/管理员可看全部；
   *  - 学员只能看本人 attempt 上的批注（不能遍历他人 attemptId）。
   */
  async listAnnotations(attemptId: string, role: string, userId: string): Promise<Annotation[]> {
    if (role === 'student') {
      const attempt = await this.attempts.findOneBy({ id: attemptId });
      if (!attempt || attempt.studentId !== userId) {
        throw new ForbiddenException('只能查看本人练习的教练批注');
      }
    }
    return this.annotations.find({
      where: { attemptId, deletedAt: IsNull() },
      order: { atSec: 'ASC' },
    });
  }
}
