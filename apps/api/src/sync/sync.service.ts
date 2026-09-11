import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import {
  User, Speaker, AudioAsset, Course, CourseItem, PracticeAttempt, Annotation,
} from '../entities';
import { mergeRecord, type EntityBucket } from '@dialect/shared';
import type {
  SyncPullResult, SyncPushPayload, SyncPushResult, Syncable,
} from '@dialect/shared';
import { MapperService } from '../resources/mapper.service';

interface BucketConfig<E> {
  repo: Repository<E & { id: string }>;
  toDto: (e: any) => any;
  canPush: (role: string) => boolean;
  /** 允许从同步 DTO 写入实体的业务字段白名单 */
  fields: string[];
  /** 其中需要从 ISO 字符串转 Date 的字段 */
  dateFields: string[];
  /** 不在 fields 中、但同步引擎仍需按日期处理的元字段 */
  metaDateFields?: string[];
}

/**
 * 离线同步引擎：
 *  PULL  GET /sync/pull?cursor=ISO  增量拉取（含软删墓碑）
 *  PUSH  POST /sync/push           按 baseVersion 三向合并（@dialect/shared mergeRecord）
 * 整个 push 单事务执行；冲突原样回传客户端裁决。
 */
@Injectable()
export class SyncService {
  private buckets: Record<EntityBucket, BucketConfig<any>>;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly mapper: MapperService,
  ) {
    this.buckets = {
      users: {
        repo: ds.getRepository(User),
        toDto: (e: User) => this.mapper.user(e),
        canPush: (r) => r === 'admin',
        fields: ['username', 'displayName', 'role'],
        dateFields: [],
      },
      speakers: {
        repo: ds.getRepository(Speaker),
        toDto: (e: Speaker) => this.mapper.speaker(e),
        canPush: (r) => r === 'investigator' || r === 'admin',
        fields: ['code', 'name', 'gender', 'birthYear', 'dialect', 'region',
          'consentStatus', 'consentScope', 'consentSignedAt', 'consentHash', 'notes'],
        dateFields: ['consentSignedAt'],
      },
      audio: {
        repo: ds.getRepository(AudioAsset),
        toDto: (e: AudioAsset) => this.mapper.audio(e),
        canPush: (r) => r === 'investigator' || r === 'coach' || r === 'admin',
        fields: ['title', 'speakerId', 'ownerId', 'dialect', 'durationSec',
          'sampleRate', 'channels', 'mime', 'waveformPeaks', 'transcript', 'translation',
          'ipa', 'syllables', 'status', 'sensitive', 'keyVersion', 'recordedAt'],
        // filePath 仅由服务端上传接口写入，客户端本地 uri 不得覆盖
        dateFields: ['recordedAt'],
      },
      courses: {
        repo: ds.getRepository(Course),
        toDto: (e: Course) => this.mapper.course(e),
        canPush: (r) => r === 'coach' || r === 'admin',
        fields: ['title', 'description', 'coachId', 'dialect', 'published', 'itemIds'],
        dateFields: [],
      },
      courseItems: {
        repo: ds.getRepository(CourseItem),
        toDto: (e: CourseItem) => this.mapper.courseItem(e),
        canPush: (r) => r === 'coach' || r === 'admin',
        fields: ['courseId', 'audioId', 'orderIndex', 'repeatTimes', 'coachTip'],
        dateFields: [],
      },
      attempts: {
        repo: ds.getRepository(PracticeAttempt),
        toDto: (e: PracticeAttempt) => this.mapper.attempt(e),
        canPush: (r) => r === 'student' || r === 'admin',
        fields: ['studentId', 'courseItemId', 'audioId', 'durationSec',
          'waveformPeaks', 'score', 'createdAt'],
        dateFields: ['createdAt'],
      },
      annotations: {
        repo: ds.getRepository(Annotation),
        toDto: (e: Annotation) => this.mapper.annotation(e),
        canPush: (r) => r === 'coach' || r === 'admin',
        fields: ['attemptId', 'coachId', 'atSec', 'comment', 'rating'],
        dateFields: [],
      },
    };
  }

  /** 增量拉取；含墓碑，客户端据此本地清理 */
  async pull(cursor: string | undefined, role: string): Promise<SyncPullResult> {
    const epoch = new Date(0).toISOString();
    const result: SyncPullResult = {
      cursor: cursor || epoch,
      users: [], speakers: [], audio: [], courses: [], courseItems: [],
      attempts: [], annotations: [],
    };

    for (const [name, cfg] of Object.entries(this.buckets) as Array<[EntityBucket, BucketConfig<any>]>) {
      const since = cursor ? new Date(cursor) : new Date(0);
      const rows = await cfg.repo
        .createQueryBuilder('e')
        .where('e.updatedAt > :since', { since })
        .orderBy('e.updatedAt', 'ASC')
        .getMany();

      let dtos = rows.map((r) => cfg.toDto(r));
      if (name === 'audio' && role === 'student') {
        dtos = dtos.filter((d) => d.status !== 'restricted');
      }
      if (name === 'users' && role !== 'admin') dtos = [];
      (result as any)[name] = dtos;
      for (const r of rows) {
        const t = new Date((r as any).updatedAt).toISOString();
        if (t > result.cursor) result.cursor = t;
      }
    }
    return result;
  }

  /** 推送合并：单事务，逐记录走共享 mergeRecord 语义 */
  async push(payload: SyncPushPayload, role: string): Promise<SyncPushResult> {
    const accepted: string[] = [];
    const conflicts: SyncPushResult['conflicts'] = [];

    await this.ds.transaction(async (manager) => {
      for (const [name, cfg] of Object.entries(this.buckets) as Array<[EntityBucket, BucketConfig<any>]>) {
        const envelopes = ((payload as any)[name] || []) as Array<{ entity: any; baseVersion: number }>;
        if (!envelopes.length) continue;
        if (!cfg.canPush(role)) throw new ForbiddenException(`角色 ${role} 不允许同步 ${name}`);

        const repo = manager.getRepository(cfg.repo.target);
        const ids = envelopes.map((e) => e.entity.id);
        const rows = await repo.find({ where: { id: In(ids) } });
        const byId = new Map<string, any>(rows.map((r: any) => [r.id, r]));

        for (const envelope of envelopes) {
          const clientEntity = envelope.entity as Syncable;
          const serverRow = byId.get(clientEntity.id);
          const serverDto = serverRow ? cfg.toDto(serverRow) : undefined;

          const outcome = mergeRecord({
            entityType: name,
            envelope: { entity: clientEntity, baseVersion: envelope.baseVersion },
            server: serverDto,
            now: () => new Date(),
          });

          if (outcome.kind === 'conflict') {
            conflicts.push(outcome.conflict);
            continue;
          }

          const won = outcome.entity as any;
          const target = serverRow ?? repo.create({ id: won.id });
          const allDateFields = new Set([...cfg.dateFields, ...(cfg.metaDateFields || ['deletedAt'])]);
          for (const f of cfg.fields) {
            if (!(f in won)) continue;
            target[f] = allDateFields.has(f) && won[f] ? new Date(won[f]) : won[f];
          }
          target.version = outcome.newVersion;
          target.deviceId = payload.deviceId || won.deviceId || target.deviceId || null;
          target.updatedAt = new Date() as any;
          if (won.deletedAt) target.deletedAt = new Date(won.deletedAt);
          await repo.save(target);
          accepted.push(won.id);
        }
      }
    });

    return { accepted, conflicts, rejected: [] };
  }
}
