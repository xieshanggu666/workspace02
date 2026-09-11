import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { readFile, unlink, writeFile } from 'fs/promises';
import * as path from 'path';
import { AudioAsset, Speaker } from '../entities';
import { MediaCryptoService } from '../media/media-crypto.service';
import { resolveWithinStorage } from '../media/path-guard';

/**
 * 知情同意状态变化时的「封口加密」执行器。
 *
 * 承诺（App 与 README）：撤回授权或素材不可分发后，服务端磁盘上的录音必须
 * 立即加密，明文文件删除，而不仅仅是把数据库状态改掉、靠下载接口返回 403。
 *
 * 触发时机（幂等，可重复执行）：
 *  - REST: 撤回授权 POST /speakers/:id/revoke；
 *  - REST: 授权范围收窄到 research（非课程/公开分发）；
 *  - 同步：设备推送了新的 speakers 状态。
 *
 * 已经加密（keyVersion 非空）的素材跳过。
 */
@Injectable()
export class ConsentEnforcementService {
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

  /** 该说话人当前授权是否允许课程/公开级分发 */
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

    const assets = await this.assets.find({
      where: { speakerId, deletedAt: IsNull() },
    });

    let sealed = 0;
    for (const asset of assets) {
      // 元数据先封口：列表/同步立即不可见、不可被改成公开
      let changed = false;
      if (!asset.sensitive) {
        asset.sensitive = true;
        changed = true;
      }
      if (asset.status !== 'restricted') {
        asset.status = 'restricted';
        changed = true;
      }

      // 文件封口：明文 → AES-256-GCM 密文
      if (asset.filePath && !asset.keyVersion) {
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
          sealed += 1;
          changed = true;
          this.logger.warn(`说话人 ${speakerId} 撤回/收窄授权，素材 ${asset.id} 已封口加密`);
        } catch (e) {
          // 元数据可能已先到（文件尚未上传）：没有物理文件时只保留元数据封口
          const msg = e instanceof Error ? e.message : String(e);
          if (!/ENOENT|非法媒体路径/.test(msg)) throw e;
        }
      }

      if (changed) {
        asset.version += 1;
        asset.updatedAt = new Date() as any;
        await this.assets.save(asset);
      }
    }
    return sealed;
  }

  /** 供同步引擎使用：拿到刚落库的说话人实体后按其状态封口 */
  async enforceSpeakerEntity(speaker: Speaker): Promise<number> {
    return this.sealSpeakerAssets(speaker.id);
  }

  /**
   * 重新获得 course/public 授权后恢复可分发状态。
   * 注意：已加密的文件【保留加密】（keyVersion 不清空、密文不解密回写），
   * 分发授权与静态加密是两件事；下载时 readMedia 会按 keyVersion 内存解密。
   */
  async restoreSpeakerAssets(speakerId: string): Promise<number> {
    const assets = await this.assets.find({
      where: { speakerId, deletedAt: IsNull() },
    });
    let changed = 0;
    for (const asset of assets) {
      if (asset.status === 'restricted') {
        // 有标注的回 annotated，否则回 draft
        asset.status = asset.syllables?.length || asset.transcript ? 'annotated' : 'draft';
        asset.version += 1;
        asset.updatedAt = new Date() as any;
        await this.assets.save(asset);
        changed += 1;
      }
    }
    return changed;
  }

  /** 存储根目录（测试用） */
  storageRoot(): string {
    return path.resolve(this.uploadDir);
  }
}
