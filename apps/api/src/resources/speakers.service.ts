import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { createHash } from 'crypto';
import { Speaker } from '../entities';
import type { ConsentScope, ConsentStatus, SpeakerDto } from '@dialect/shared';
import { MapperService } from './mapper.service';
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
  ) {}

  list(): Promise<Speaker[]> {
    return this.repo.find({ where: { deletedAt: IsNull() }, order: { updatedAt: 'DESC' } });
  }

  async get(id: string): Promise<Speaker> {
    const s = await this.repo.findOneBy({ id });
    if (!s || s.deletedAt) throw new NotFoundException('说话人不存在');
    return s;
  }

  async upsert(dto: SpeakerDto, deviceId?: string): Promise<Speaker> {
    const existing = await this.repo.findOneBy({ id: dto.id });
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
    entity.consentSignedAt = dto.consentSignedAt ? new Date(dto.consentSignedAt) : null;
    entity.version = existing ? existing.version + 1 : Math.max(1, dto.version);
    entity.updatedAt = new Date() as any;
    return this.repo.save(entity);
  }

  async softDelete(id: string): Promise<void> {
    await this.repo.update(id, { deletedAt: new Date(), updatedAt: new Date() as any });
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
    const hash = `sha256:${createHash('sha256')
      .update(`${body.agreementText}||${s.code}||${body.scope}`)
      .digest('hex')}`;
    s.consentStatus = 'granted' as ConsentStatus;
    s.consentScope = body.scope;
    s.consentHash = hash;
    s.consentSignedAt = new Date(body.signedAt || Date.now());
    s.version += 1;
    s.updatedAt = new Date() as any;
    const saved = await this.repo.save(s);
    return this.mapper.speaker(saved);
  }

  /** 撤回授权（被调查人行使删除/撤回权时调用） */
  async revokeConsent(id: string, _user?: JwtPayload): Promise<SpeakerDto> {
    const s = await this.get(id);
    s.consentStatus = 'revoked';
    s.consentScope = null;
    s.version += 1;
    s.updatedAt = new Date() as any;
    const saved = await this.repo.save(s);
    return this.mapper.speaker(saved);
  }
}
