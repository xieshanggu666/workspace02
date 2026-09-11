import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { readFile, unlink, writeFile } from 'fs/promises';
import { AudioAsset, Speaker } from '../entities';
import { mustEncryptAtRest } from '@dialect/shared';
import { MediaCryptoService } from '../media/media-crypto.service';
import { resolveWithinStorage } from '../media/path-guard';

/**
 * 知情同意状态变化时的「封口加密」执行器，并负责“落盘即密文”的最终保证。
 *
 * 承诺（App 与 README）：只要录音不属于可课程/公开分发（sensitive、
 * research、pending、revoked、说话人缺失），磁盘上就不能出现明文文件，
 * 否则备份与快照会永久留存原始录音。
 *
 * 两条防线：
 *  1. 上传瞬间：AudioService.attachFile 调 mustEncryptAtRest，直接写密文，
 *     明文从未落盘（覆盖“给一开始就是 research 的说话人新录音”的场景）；
 *  2. 状态收口 + 启动自愈：授权迁移到不可分发时封口既有明文；
 *     reconcileAllAssets() 在启动时扫描并修复历史遗留明文。
 *
 * research（已授予仅研究）保留素材自身 status；撤回/待签置 restricted。
 */
@Injectable()
export class ConsentEnforcementService implements OnModuleInit {
  private readonly logger = new Logger(ConsentEnforcementService.name);
  private readonly crypto: MediaCryptoService;
  private readonly uploadDir: string;

  constructor(
    @InjectRepository(Speaker) private readonly speakers: Repository<Speaker>,
    @InjectRepository(AudioAsset) private readonly assets: Repository<AudioAsset>,
    config: ConfigService,
  ) {
    this.crypto = new MediaCryptoService(config.get<string>('app.masterKeyHex')!);
    this.uploadDir = config.get<string>('app.uploadDir')!;
  }

  async onModuleInit(): Promise<void> {
    // 启动自愈：修复历史/异常路径留下的明文。失败不应阻断启动。
    try {
      const n = await this.reconcileAllAssets();
      if (n > 0) this.logger.warn(`启动封口自愈：${n} 个不可分发素材由明文改为密文`);
    } catch (e) {
      this.logger.error(`启动封口扫描失败: ${(e as Error).message}`);
    }
  }

  private isDistributable(speaker: Pick<Speaker, 'consentStatus' | 'consentScope'>): boolean {
    return (
      speaker.consentStatus === 'granted' &&
      (speaker.consentScope === 'course' || speaker.consentScope === 'public')
    );
  }

  /**
   * 按说话人当前状态封口其全部素材。
   * @returns 本次实际新加密的文件数
   */
  async sealSpeakerAssets(speakerId: string): Promise<number> {
    const speaker = await this.speakers.findOneBy({ id: speakerId });
    if (!speaker) return 0;
    if (this.isDistributable(speaker)) return 0;

    const keepOwnStatus =
      speaker.consentStatus === 'granted' && speaker.consentScope === 'research';

    const assets = await this.assets.find({
      where: { speakerId, deletedAt: IsNull() },
    });

    let sealed = 0;
    for (const asset of assets) {
      let changed = false;
      // research 保留素材自身状态；撤回/待签等置 restricted
      if (!keepOwnStatus && asset.status !== 'restricted') {
        asset.status = 'restricted';
        changed = true;
      }
      if (await this.sealOneAsset(asset, speaker, keepOwnStatus)) {
        sealed += 1;
        changed = true;
      }
      if (changed) {
        asset.version += 1;
        asset.updatedAt = new Date() as any;
        await this.assets.save(asset);
      }
    }
    return sealed;
  }

  /**
   * 把单个素材的明文文件（若存在且按授权必须加密）封口为 GCM 密文。
   * 幂等：已加密（keyVersion 非空）直接返回 false。
   * @returns 是否实际新加密
   */
  private async sealOneAsset(
    asset: AudioAsset,
    speaker: Pick<Speaker, 'consentStatus' | 'consentScope'> | null,
    _keepOwnStatus: boolean,
  ): Promise<boolean> {
    const must = mustEncryptAtRest({
      sensitive: asset.sensitive,
      consentStatus: speaker?.consentStatus,
      consentScope: speaker?.consentScope,
    });
    if (!must) return false;
    if (!asset.filePath || asset.keyVersion) return false;

    const keyVersion = 1;
    const plainRel = asset.filePath;
    const encRel = plainRel.endsWith('.enc') ? plainRel : `${plainRel}.enc`;
    try {
      const plain = await readFile(resolveWithinStorage(this.uploadDir, plainRel));
      const enc = this.crypto.encrypt(plain, asset.id, keyVersion);
      await writeFile(resolveWithinStorage(this.uploadDir, encRel), enc);
      await unlink(resolveWithinStorage(this.uploadDir, plainRel));
      asset.filePath = encRel;
      asset.keyVersion = keyVersion;
      this.logger.warn(`素材 ${asset.id} 按授权要求封口为密文`);
      return true;
    } catch (e) {
      // 文件尚未上传（只有元数据）时无需物理封口
      const msg = e instanceof Error ? e.message : String(e);
      if (/ENOENT|非法媒体路径/.test(msg)) return false;
      throw e;
    }
  }

  /**
   * 启动/维护自愈：扫描全部素材，凡按当前授权必须加密却仍以明文存储的，
   * 立即封口。用于修复历史数据（例如旧版本给 research 说话人留下的明文），幂等。
   */
  async reconcileAllAssets(): Promise<number> {
    const assets = await this.assets.find({ where: { deletedAt: IsNull() } });
    const speakers = await this.speakers.findBy({
      id: In(Array.from(new Set(assets.map((a) => a.speakerId)))),
    });
    const spk = new Map(speakers.map((s) => [s.id, s]));
    let sealed = 0;
    for (const asset of assets) {
      const s = spk.get(asset.speakerId) ?? null;
      const changed = await this.sealOneAsset(asset, s, s?.consentScope === 'research');
      if (changed) {
        asset.version += 1;
        asset.updatedAt = new Date() as any;
        await this.assets.save(asset);
        sealed += 1;
      }
    }
    return sealed;
  }

  /**
   * 重新获得 course/public 授权后恢复可分发状态。
   * 已加密文件保留加密（下载时内存解密）；仅恢复因撤回置 restricted 的状态。
   */
  async restoreSpeakerAssets(speakerId: string): Promise<number> {
    const assets = await this.assets.find({
      where: { speakerId, deletedAt: IsNull() },
    });
    let changed = 0;
    for (const asset of assets) {
      if (asset.status === 'restricted') {
        asset.status = asset.syllables?.length || asset.transcript ? 'annotated' : 'draft';
        asset.version += 1;
        asset.updatedAt = new Date() as any;
        await this.assets.save(asset);
        changed += 1;
      }
    }
    return changed;
  }

  storageRoot(): string {
    return this.uploadDir;
  }
}
