import {
  ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { mkdir, writeFile, readFile } from 'fs/promises';
import * as path from 'path';
import { AudioAsset, Speaker } from '../entities';
import type { AudioAssetDto } from '@dialect/shared';
import { MapperService } from './mapper.service';
import { MediaCryptoService } from '../media/media-crypto.service';
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

  async list(filter?: { dialect?: string; speakerId?: string; includeRestricted?: boolean }): Promise<AudioAsset[]> {
    const where: any = { deletedAt: IsNull() };
    if (filter?.dialect) where.dialect = filter.dialect;
    if (filter?.speakerId) where.speakerId = filter.speakerId;
    if (!filter?.includeRestricted) where.status = Not('restricted');
    return this.repo.find({ where, order: { recordedAt: 'DESC' } });
  }

  async getEntity(id: string): Promise<AudioAsset> {
    const a = await this.repo.findOneBy({ id });
    if (!a || a.deletedAt) throw new NotFoundException('音频不存在');
    return a;
  }

  async getDto(id: string) {
    return this.mapper.audio(await this.getEntity(id));
  }

  async upsert(dto: AudioAssetDto, deviceId?: string): Promise<AudioAsset> {
    const existing = await this.repo.findOneBy({ id: dto.id });
    const entity = existing ?? this.repo.create({ id: dto.id, recordedAt: new Date(dto.recordedAt) });
    Object.assign(entity, {
      title: dto.title,
      speakerId: dto.speakerId,
      ownerId: dto.ownerId,
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
      sensitive: dto.sensitive,
      keyVersion: dto.keyVersion ?? null,
      filePath: dto.filePath ?? entity.filePath ?? null,
      deviceId: deviceId ?? dto.deviceId ?? entity.deviceId,
    });
    entity.recordedAt = new Date(dto.recordedAt) as any;
    entity.version = existing ? existing.version + 1 : Math.max(1, dto.version);
    entity.updatedAt = new Date() as any;
    return this.repo.save(entity);
  }

  async attachFile(id: string, data: Buffer): Promise<AudioAsset> {
    const asset = await this.getEntity(id);
    const keyVersion = asset.sensitive ? Math.max(1, asset.keyVersion ?? 1) : null;
    const payload = keyVersion ? this.crypto.encrypt(data, asset.id, keyVersion) : data;
    const ext = keyVersion ? 'wav.enc' : 'wav';
    const rel = `audio/${asset.id}.${ext}`;
    await writeFile(path.join(this.uploadDir, rel), payload);
    asset.filePath = rel;
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
    role: 'investigator' | 'speaker' | 'coach' | 'student' | 'admin',
  ): Promise<{ mime: string; data: Buffer }> {
    const asset = await this.getEntity(id);
    const speaker = await this.speakers.findOneBy({ id: asset.speakerId });
    const trusted = role === 'investigator' || role === 'admin' || role === 'coach';

    if (speaker?.consentStatus === 'revoked' && !(role === 'investigator' || role === 'admin')) {
      throw new ForbiddenException('该说话人已撤回授权，素材禁止分发');
    }
    if ((asset.sensitive || speaker?.consentStatus === 'pending') && !trusted) {
      throw new ForbiddenException('受限录音：授权未完成，需调查员/教练权限');
    }
    if (!asset.filePath) throw new NotFoundException('媒体文件尚未上传');

    const raw = await readFile(path.join(this.uploadDir, asset.filePath));
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
    await this.repo.update(id, { deletedAt: new Date(), updatedAt: new Date() as any });
  }
}
