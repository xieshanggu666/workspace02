import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { readFile, unlink, writeFile } from 'fs/promises';
import { AudioAsset, Speaker } from '../entities';
import { MediaCryptoService } from '../media/media-crypto.service';
import { resolveWithinStorage } from '../media/path-guard';

/**
 * 知情同意状态变化时的「封口加密」执行器。
 *
 * 承诺（App 与 README）：撤回授权或素材不再可分发后，服务端磁盘上的录音必须
 * 立即加密，明文文件删除，而不仅仅是把数据库状态改掉、靠下载接口返回 403。
 *
 * 设计要点（两个正交的概念）：
 *  - 是否可分发：由说话人 consentStatus/consentScope 决定（见 canAccessMedia），
 *    与素材本身是否加密无关；
 *  - 是否加密落盘：本服务负责。凡进入「不可分发」状态的素材，文件一律 AES-GCM 加密。
 *  因此 research（仍保留 annotated 状态）与 revoked（应置 restricted）处理不同：
 *    research：只加密文件，status 保持 annotated；
 *    revoked / pending：加密文件并把 status 置为 restricted。
 *
 * 触发（幂等，可重复执行）：REST 通用 upsert、/revoke、/consent，以及 sync push。
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

    // research（已授予但仅研究）保留原 status；其余不可分发状态置 restricted
    const keepOwnStatus =
      speaker.consentStatus === 'granted' && speaker.consentScope === 'research';

    const assets = await this.assets.find({
      where: { speakerId, deletedAt: IsNull() },
    });

    let sealed = 0;
    for (const asset of assets) {
      let changed = false;

      if (!keepOwnStatus && asset.status !== 'restricted') {
        asset.status = 'restricted';
        changed = true;
      }
      if (!asset.sensitive) {
        asset.sensitive = true;
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
          this.logger.warn(`说话人 ${speakerId} 授权不可分发，素材 ${asset.id} 已封口加密`);
        } catch (e) {
          // 文件尚未上传时只封元数据
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

  /**
   * 重新获得 course/public 授权后恢复可分发状态。
   * 已加密的文件【保留加密】（keyVersion 不清空），下载时按 keyVersion 内存解密；
   * 仅把因撤回而置 restricted 的素材恢复为可展示状态。
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

  /** 存储根目录（测试用） */
  storageRoot(): string {
    return this.uploadDir;
  }
}
