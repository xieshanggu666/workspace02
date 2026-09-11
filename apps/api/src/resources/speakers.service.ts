import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { createHash } from 'crypto';
import { Speaker } from '../entities';
import type { ConsentScope, ConsentStatus, SpeakerDto } from '@dialect/shared';
import { sanitizeClientTime, consentTransition } from '@dialect/shared';
import { MapperService } from './mapper.service';
import { ConsentEnforcementService } from './consent-enforcement.service';
import { JwtPayload } from '../auth/auth.guard';

/**
 * 说话人档案与知情同意。
 * consentHash = sha256(授权文本 + 说话人 code + scope)，用于核验协议未被篡改；
 * 撤回授权会把名下所有录音置为 restricted 并要求加密（合规闸门）。
 */
@Injectable()
export class SpeakersService {
  constructor(
    @InjectRepository(Speaker) private readonly repo: Repository<Speaker>,
    private readonly mapper: MapperService,
    private readonly enforcement: ConsentEnforcementService,
  ) {}

  list(): Promise<Speaker[]> {
    return this.repo.find({ where: { deletedAt: IsNull() }, order: { updatedAt: 'DESC' } });
  }

  async get(id: string): Promise<Speaker> {
    const s = await this.repo.findOneBy({ id });
    if (!s || s.deletedAt) throw new NotFoundException('说话人不存在');
    return s;
  }

  /**
   * 通用说话人 upsert（POST/PUT /speakers 与现场建档共用）。
   * 关键：授权状态/范围的任何变化都必须触发与 /revoke、/consent 一致的收口，
   * 不能因为走的是「通用更新接口」就绕过文件封口。
   */
  async upsert(dto: SpeakerDto, deviceId?: string): Promise<Speaker> {
    const existing = await this.repo.findOneBy({ id: dto.id });
    const before = existing
      ? { consentStatus: existing.consentStatus, consentScope: existing.consentScope }
      : null;

    const entity = existing ?? this.repo.create({ id: dto.id });
    Object.assign(entity, {
      code: dto.code,
      name: dto.name,
      gender: dto.gender ?? null,
      birthYear: dto.birthYear ?? null,
      dialect: dto.dialect,
      region: dto.region,
      consentStatus: dto.consentStatus,
      consentScope: dto.consentScope ?? null,
      consentHash: dto.consentHash ?? null,
      notes: dto.notes ?? null,
      deviceId: deviceId ?? dto.deviceId ?? entity.deviceId,
    });
    entity.consentSignedAt = dto.consentSignedAt ? sanitizeClientTime(dto.consentSignedAt) : null;
    entity.version = existing ? existing.version + 1 : Math.max(1, dto.version);
    entity.updatedAt = new Date() as any;
    const saved = await this.repo.save(entity);

    // 统一收口：撤回 / 范围缩减 / 新建即不可分发 → 封口；恢复 course/public → 还原
    const action = consentTransition(before, {
      consentStatus: entity.consentStatus,
      consentScope: entity.consentScope,
    });
    if (action === 'seal') await this.enforcement.sealSpeakerAssets(dto.id);
    else if (action === 'restore') await this.enforcement.restoreSpeakerAssets(dto.id);

    return saved;
  }

  async softDelete(id: string): Promise<void> {
    await this.repo.update(id, { deletedAt: new Date(), updatedAt: new Date() as any, serverUpdatedAt: new Date() });
  }

  /** 记录一次电子/纸质授权签署 */
  async grantConsent(
    id: string,
    body: { scope: ConsentScope; agreementText: string; signedAt?: string },
  ): Promise<SpeakerDto> {
    const s = await this.get(id);
    if (!body.scope || !body.agreementText?.trim()) {
      throw new BadRequestException('授权范围与协议全文必填');
    }
    const existingBeforeGrant = {
      consentStatus: s.consentStatus,
      consentScope: s.consentScope,
    };
    const hash = `sha256:${createHash('sha256')
      .update(`${body.agreementText}||${s.code}||${body.scope}`)
      .digest('hex')}`;
    s.consentStatus = 'granted' as ConsentStatus;
    s.consentScope = body.scope;
    s.consentHash = hash;
    s.consentSignedAt = sanitizeClientTime(body.signedAt || new Date().toISOString());
    const before = {
      consentStatus: existingBeforeGrant.consentStatus,
      consentScope: existingBeforeGrant.consentScope,
    };
    s.version += 1;
    s.updatedAt = new Date() as any;
    const saved = await this.repo.save(s);

    const action = consentTransition(before, { consentStatus: 'granted', consentScope: body.scope });
    if (action === 'seal') await this.enforcement.sealSpeakerAssets(id);
    else if (action === 'restore') await this.enforcement.restoreSpeakerAssets(id);

    return this.mapper.speaker(saved);
  }

  /**
   * 撤回授权（被调查人行使删除/撤回权时调用）。
   * 不仅翻转状态，还必须把名下明文录音封口为 AES-GCM 密文、删除明文，
   * 与「撤回即封口」的界面与文档承诺一致。
   * @returns 更新后的说话人 + 本次新加密文件数
   */
  async revokeConsent(
    id: string,
    _user?: JwtPayload,
  ): Promise<{ speaker: SpeakerDto; sealed: number }> {
    const s = await this.get(id);
    s.consentStatus = 'revoked';
    s.consentScope = null;
    s.version += 1;
    s.updatedAt = new Date() as any;
    const saved = await this.repo.save(s);
    // 撤回后必然不可分发：直接封口（幂等，已加密素材跳过）
    const sealed = await this.enforcement.sealSpeakerAssets(id);
    return { speaker: this.mapper.speaker(saved), sealed };
  }
}
