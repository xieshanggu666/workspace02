import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import {
  User, Speaker, AudioAsset, Course, CourseItem, PracticeAttempt, Annotation,
} from '../entities';
import { mergeRecord, canAccessMedia, canUseInCourse, type EntityBucket } from '@dialect/shared';
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
        // 注意：filePath / keyVersion 绝不在白名单内——它们只由服务端上传接口生成，
        // 客户端推送无法借此植入路径穿越或篡改加密标记。
        // sensitive / speakerId / ownerId 对教练只读（见 push 内按角色二次过滤）。
        fields: ['title', 'speakerId', 'ownerId', 'dialect', 'durationSec',
          'sampleRate', 'channels', 'mime', 'waveformPeaks', 'transcript', 'translation',
          'ipa', 'syllables', 'status', 'sensitive', 'recordedAt'],
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
        fields: ['studentId', 'courseItemId', 'audioId', 'durationSec', 'mime',
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

  /**
   * 增量拉取；含墓碑，客户端据此本地清理。
   *
   * 隐私/同意范围边界：
   *  - attempts     学员仅本人提交；annotations 仅本人 attempt 上的批注；
   *  - audio        学员/教练只收到同意范围允许分发的素材
   *                 （research/pending/revoked/敏感素材不下发），staff 全量；
   *  - users        仅 admin。
   */
  async pull(
    cursor: string | undefined,
    role: string,
    userId: string,
  ): Promise<SyncPullResult> {
    const epoch = new Date(0).toISOString();
    const result: SyncPullResult = {
      cursor: cursor || epoch,
      users: [], speakers: [], audio: [], courses: [], courseItems: [],
      attempts: [], annotations: [],
    };

    // 非 staff 角色需要说话人授权信息来过滤 audio
    const staff = role === 'investigator' || role === 'admin';
    let speakerMap = new Map<string, Speaker>();
    let allowedAudioForStudent: Set<string> | null = null;
    if (!staff) {
      const all = await this.buckets.speakers.repo.find();
      speakerMap = new Map(all.map((s) => [s.id, s as Speaker]));
    }
    if (role === 'student') {
      const allAssets = await this.buckets.audio.repo.find();
      allowedAudioForStudent = new Set(
        allAssets
          .filter((a) =>
            canAccessMedia(
              {
                consentStatus: speakerMap.get(a.speakerId)?.consentStatus,
                consentScope: speakerMap.get(a.speakerId)?.consentScope,
                sensitive: a.sensitive,
              },
              'student',
            ),
          )
          .map((a) => a.id),
      );
    }

    for (const [name, cfg] of Object.entries(this.buckets) as Array<[EntityBucket, BucketConfig<any>]>) {
      const since = cursor ? new Date(cursor) : new Date(0);
      const rows = await cfg.repo
        .createQueryBuilder('e')
        .where('e.updatedAt > :since', { since })
        .orderBy('e.updatedAt', 'ASC')
        .getMany();

      let dtos = rows.map((r) => cfg.toDto(r));
      if (name === 'audio' && !staff) {
        dtos = dtos.filter((d) => {
          const spk = speakerMap.get(d.speakerId);
          return canAccessMedia(
            {
              consentStatus: spk?.consentStatus,
              consentScope: spk?.consentScope,
              sensitive: d.sensitive,
            },
            role as any,
          );
        });
      }
      if (name === 'users' && role !== 'admin') {
        dtos = [];
      }
      // 学员的课程条目只保留指向授权范围内素材的
      if (name === 'courseItems' && role === 'student' && allowedAudioForStudent) {
        dtos = dtos.filter((d) => allowedAudioForStudent!.has(d.audioId));
      }
      if (role === 'student') {
        if (name === 'attempts') {
          dtos = dtos.filter((d) => d.studentId === userId);
        } else if (name === 'annotations') {
          const ownAttemptIds = new Set(
            (result.attempts as Array<{ id: string }>).map((a) => a.id),
          );
          // 增量同步时本批可能不含 attempt 本身（更早的游标已拉过），
          // 因此再查一次本人 attempt id 兜底。
          if (ownAttemptIds.size === 0) {
            const own = await this.buckets.attempts.repo.find({ where: { studentId: userId } as any });
            own.forEach((a) => ownAttemptIds.add((a as any).id));
          }
          dtos = dtos.filter((d) => ownAttemptIds.has(d.attemptId));
        }
      }
      (result as any)[name] = dtos;
      for (const r of rows) {
        const t = new Date((r as any).updatedAt).toISOString();
        if (t > result.cursor) result.cursor = t;
      }
    }
    return result;
  }

  /**
   * 推送合并：单事务，逐记录走共享 mergeRecord 语义。
   * 归属强制：学员推送 attempts 时，记录（无论新建还是覆盖已有记录）必须属于本人；
   * 服务端以登录身份 userId 覆盖 studentId，杜绝冒名/篡改他人练习。
   */
  async push(payload: SyncPushPayload, role: string, userId: string): Promise<SyncPushResult> {
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

          // 越权防护：学员只能写本人的练习记录（新建/覆盖均校验）
          if (role === 'student' && name === 'attempts') {
            if (serverRow && serverRow.studentId !== userId) {
              throw new ForbiddenException('不能修改其他学员的练习记录');
            }
            (clientEntity as any).studentId = userId; // 以登录身份为准
          }

          // 教练同步音频时：归属/敏感字段以服务端为准，且禁止把敏感降级
          if (name === 'audio' && role === 'coach' && serverRow) {
            (clientEntity as any).speakerId = serverRow.speakerId;
            (clientEntity as any).ownerId = serverRow.ownerId;
            if (serverRow.sensitive) {
              (clientEntity as any).sensitive = true;
              (clientEntity as any).status =
                (clientEntity as any).status === 'restricted' ? 'restricted' : serverRow.status;
            }
          }
          if (name === 'audio' && role !== 'investigator' && role !== 'admin' && serverRow) {
            // 非 staff 永不允许翻 sensitive
            if (serverRow.sensitive) (clientEntity as any).sensitive = true;
          }

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

          // 同意范围闸门：课程条目不能引用仅限研究/未授权/已撤回的素材
          if (name === 'courseItems' && !won.deletedAt && won.audioId) {
            const asset = await manager
              .getRepository(AudioAsset)
              .findOneBy({ id: won.audioId });
            const spk = asset
              ? await manager.getRepository(Speaker).findOneBy({ id: asset.speakerId })
              : null;
            if (!asset || !canUseInCourse(
              { consentStatus: spk?.consentStatus, consentScope: spk?.consentScope },
              'coach',
            )) {
              throw new ForbiddenException(
                `课程条目引用的素材 ${won.audioId} 不在课程授权范围内（research/pending/revoked 不可编入课程）`,
              );
            }
          }

          const target = serverRow ?? repo.create({ id: won.id });
          const allDateFields = new Set([...cfg.dateFields, ...(cfg.metaDateFields || ['deletedAt'])]);
          for (const f of cfg.fields) {
            if (!(f in won)) continue;
            target[f] = allDateFields.has(f) && won[f] ? new Date(won[f]) : won[f];
          }
          target.version = outcome.newVersion;
          target.deviceId = payload.deviceId || won.deviceId || target.deviceId || null;
          // LWW 语义要求 updatedAt 表示「最后一次编辑发生的时间」，必须随记录传播；
          // 若用服务器收货时间覆盖，离线设备带真实编辑时间的写入会被错误排序。
          // 仅在客户端缺时间戳时退回服务器时钟。
          target.updatedAt = (won.updatedAt ? new Date(won.updatedAt) : new Date()) as any;
          if (won.deletedAt) target.deletedAt = new Date(won.deletedAt);
          await repo.save(target);
          accepted.push(won.id);
        }
      }
    });

    return { accepted, conflicts, rejected: [] };
  }
}
