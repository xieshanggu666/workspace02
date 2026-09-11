import {
  ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { mkdir, writeFile, readFile } from 'fs/promises';
import * as path from 'path';
import { AudioAsset, Speaker } from '../entities';
import type { AudioAssetDto, AppRole } from '@dialect/shared';
import { canAccessMedia, mediaDenyReason, sanitizeClientTime, mustEncryptAtRest } from '@dialect/shared';
import { MapperService } from './mapper.service';
import { MediaCryptoService } from '../media/media-crypto.service';
import { resolveWithinStorage } from '../media/path-guard';
import { SpeakersService } from './speakers.service';

/**
 * 音频素材：元数据 CRUD + 密文媒体落盘。
 *
 * 访问控制（读取媒体二进制时强制）：
 *  - speaker.consentStatus === 'revoked' → 仅 admin/investigator 可取，且仅供归档；教练/学员 403
 *  - speaker.consentStatus === 'pending' 或 asset.sensitive → 必须为 investigator/coach/admin
 *  - 敏感文件以 AES-256-GCM 加密存储，磁盘上不存在明文 WAV
 */
@Injectable()
export class AudioService implements OnModuleInit {
  private readonly logger = new Logger(AudioService.name);
  private crypto: MediaCryptoService;
  private uploadDir: string;

  constructor(
    @InjectRepository(AudioAsset) private readonly repo: Repository<AudioAsset>,
    @InjectRepository(Speaker) private readonly speakers: Repository<Speaker>,
    private readonly mapper: MapperService,
    private readonly speakersService: SpeakersService,
    config: ConfigService,
  ) {
    this.crypto = new MediaCryptoService(config.get<string>('app.masterKeyHex')!);
    this.uploadDir = config.get<string>('app.uploadDir')!;
  }

  async onModuleInit() {
    await mkdir(path.join(this.uploadDir, 'audio'), { recursive: true });
    await mkdir(path.join(this.uploadDir, 'attempts'), { recursive: true });
  }

  /**
   * 列表按角色执行知情同意范围过滤：
   *  - investigator/admin：全部（含 restricted、research、pending、revoked）
   *  - coach：已授予且 scope ∈ {course,public} 的素材（research/pending/revoked 不列）
   *  - student：同教练集合，但课程引用下载仍会再做一次闸门校验
   */
  async list(
    filter: { dialect?: string; speakerId?: string; includeRestricted?: boolean; role?: AppRole } = {},
  ): Promise<AudioAsset[]> {
    const where: any = { deletedAt: IsNull() };
    if (filter.dialect) where.dialect = filter.dialect;
    if (filter.speakerId) where.speakerId = filter.speakerId;
    const staff = filter.role === 'investigator' || filter.role === 'admin';
    if (!filter.includeRestricted && !staff) where.status = Not('restricted');
    const rows = await this.repo.find({ where, order: { recordedAt: 'DESC' } });
    if (staff) return rows;

    const speakers = await this.speakers.findBy({
      id: In(Array.from(new Set(rows.map((r) => r.speakerId)))),
    });
    const byId = new Map(speakers.map((s) => [s.id, s]));
    return rows.filter((r) => {
      const spk = byId.get(r.speakerId);
      return canAccessMedia(
        {
          consentStatus: spk?.consentStatus,
          consentScope: spk?.consentScope,
          sensitive: r.sensitive,
        },
        filter.role || 'student',
      );
    });
  }

  async getEntity(id: string): Promise<AudioAsset> {
    const a = await this.repo.findOneBy({ id });
    if (!a || a.deletedAt) throw new NotFoundException('音频不存在');
    return a;
  }

  async getDto(id: string, role?: AppRole) {
    const a = await this.getEntity(id);
    if (role) {
      const spk = await this.speakers.findOneBy({ id: a.speakerId });
      if (!canAccessMedia(
        { consentStatus: spk?.consentStatus, consentScope: spk?.consentScope, sensitive: a.sensitive },
        role,
      )) {
        throw new ForbiddenException(
          mediaDenyReason(
            { consentStatus: spk?.consentStatus, consentScope: spk?.consentScope, sensitive: a.sensitive },
            role,
          ),
        );
      }
    }
    return this.mapper.audio(a);
  }

  /**
   * upsert 元数据。
   * 安全：
   *  - filePath / keyVersion 永远不接受客户端输入（只能由 attachFile 服务端生成），
   *    否则可写入 ../../.env 之类路径，再经下载接口读取任意文件；
   *  - 教练只能改标注层（转写/音节/状态流转），不能改归属、说话人、敏感标记；
   *  - 任何人都不能通过编辑把受限素材自行降级为公开。
   */
  async upsert(
    dto: AudioAssetDto,
    deviceId?: string,
    actor?: { role: AppRole; userId: string },
  ): Promise<AudioAsset> {
    const existing = await this.repo.findOneBy({ id: dto.id });
    // 缺省 actor 仅用于系统内部调用（同步引擎、种子、测试）；HTTP 入口必须显式传角色
    const role: AppRole = actor?.role ?? 'investigator';
    const isCoach = role === 'coach';
    const entity = existing ?? this.repo.create({ id: dto.id, recordedAt: new Date(dto.recordedAt) });

    Object.assign(entity, {
      title: dto.title,
      dialect: dto.dialect,
      durationSec: dto.durationSec,
      sampleRate: dto.sampleRate,
      channels: dto.channels,
      mime: dto.mime,
      waveformPeaks: dto.waveformPeaks ?? [],
      transcript: dto.transcript ?? null,
      translation: dto.translation ?? null,
      ipa: dto.ipa ?? null,
      syllables: dto.syllables ?? [],
      status: dto.status,
      deviceId: deviceId ?? dto.deviceId ?? entity.deviceId,
    });

    if (!isCoach) {
      // 调查员/管理员可改归属与说话人
      entity.speakerId = dto.speakerId;
      entity.ownerId = dto.ownerId;
    }

    // sensitive 是安全字段：
    //  - 教练：完全不可写，保留原值；
    //  - staff（含系统内部调用）：只允许「升级为敏感」，不能把受限素材降级。
    const staff = role === 'investigator' || role === 'admin';
    if (isCoach) {
      entity.sensitive = existing ? existing.sensitive : false;
    } else if (staff) {
      const nextSensitive = !!dto.sensitive;
      if (existing?.sensitive && !nextSensitive) {
        throw new ForbiddenException('不能将已标记为敏感的录音降级为公开');
      }
      entity.sensitive = nextSensitive;
      if (nextSensitive) entity.keyVersion = Math.max(1, entity.keyVersion ?? 1);
    }

    // filePath / keyVersion 刻意不从 dto 读取：保持服务端既有值
    entity.filePath = entity.filePath ?? null;
    if (!entity.keyVersion) entity.keyVersion = null;

    entity.recordedAt = sanitizeClientTime(dto.recordedAt) as any;
    entity.version = existing ? existing.version + 1 : Math.max(1, dto.version);
    entity.updatedAt = new Date() as any;
    return this.repo.save(entity);
  }

  /**
   * 上传/替换录音二进制。
   * 是否加密在文件落盘的瞬间按「说话人授权 + 素材敏感标记」决定：
   * 只要不是可课程/公开分发（research/pending/revoked/无说话人）或 sensitive，
   * 就直接写密文——明文从未存在于磁盘，杜绝经备份/快照泄露。
   */
  async attachFile(id: string, data: Buffer, mime?: string): Promise<AudioAsset> {
    const asset = await this.getEntity(id);
    const speaker = await this.speakers.findOneBy({ id: asset.speakerId });
    const encryptAtRest = mustEncryptAtRest({
      sensitive: asset.sensitive,
      consentStatus: speaker?.consentStatus,
      consentScope: speaker?.consentScope,
    });
    const keyVersion = encryptAtRest ? Math.max(1, asset.keyVersion ?? 1) : null;
    const payload = keyVersion ? this.crypto.encrypt(data, asset.id, keyVersion) : data;
    const rawExt = mime === 'audio/mp4' || mime === 'audio/m4a' || mime === 'audio/aac'
      ? 'm4a'
      : 'wav';
    const ext = keyVersion ? `${rawExt}.enc` : rawExt;
    const rel = `audio/${asset.id}.${ext}`;
    await writeFile(resolveWithinStorage(this.uploadDir, rel), payload);
    asset.filePath = rel;
    if (mime) asset.mime = mime;
    asset.keyVersion = keyVersion;
    asset.version += 1;
    asset.updatedAt = new Date() as any;
    return this.repo.save(asset);
  }

  /**
   * 读取媒体：根据角色与授权状态进行合规闸门检查，敏感录音在内存中解密。
   * 返回 { mime, data }。
   */
  async readMedia(
    id: string,
    role: AppRole,
  ): Promise<{ mime: string; data: Buffer }> {
    const asset = await this.getEntity(id);
    const speaker = await this.speakers.findOneBy({ id: asset.speakerId });
    const ctx = {
      consentStatus: speaker?.consentStatus,
      consentScope: speaker?.consentScope,
      sensitive: asset.sensitive,
    };

    // 统一的知情同意闸门：research/pending/revoked/敏感素材对越界角色一律 403
    if (!canAccessMedia(ctx, role)) {
      throw new ForbiddenException(mediaDenyReason(ctx, role));
    }
    if (!asset.filePath) throw new NotFoundException('媒体文件尚未上传');

    // 纵深防御：filePath 必须落在存储根目录、且符合服务端命名规则
    const absPath = resolveWithinStorage(this.uploadDir, asset.filePath);
    const raw = await readFile(absPath);
    const data = asset.keyVersion ? this.crypto.decrypt(raw, asset.id, asset.keyVersion) : raw;
    this.logger.log(`媒体读取 id=${id} role=${role} encrypted=${!!asset.keyVersion}`);
    return { mime: asset.mime, data };
  }

  /** 撤回授权后批量封口：全部置 restricted + sensitive */
  async lockBySpeaker(speakerId: string): Promise<number> {
    const assets = await this.repo.findBy({ speakerId, deletedAt: IsNull() });
    for (const a of assets) {
      a.status = 'restricted';
      a.sensitive = true;
      if (!a.keyVersion) a.keyVersion = 1;
      a.version += 1;
      a.updatedAt = new Date() as any;
    }
    await this.repo.save(assets);
    return assets.length;
  }

  async softDelete(id: string): Promise<void> {
    await this.repo.update(id, { deletedAt: new Date(), updatedAt: new Date() as any, serverUpdatedAt: new Date() });
  }
}
