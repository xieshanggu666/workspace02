import { createCipheriv, createDecipheriv, createHash } from 'crypto';

/**
 * 敏感录音的静态加密（AES-256-GCM）。
 *
 * 威胁模型：服务器磁盘 / 备份被未授权拷走时，restricted 录音不可被直接打开。
 * 主密钥来自环境变量 MEDIA_MASTER_KEY_HEX；单条媒体派生密钥 = HKDF 风格的
 * SHA-256(master || assetId || keyVersion)，做到一录一密、可轮换。
 *
 * 移动端在本地同样使用 AES-GCM（见 mobile/src/crypto），密钥通过登录后
 * 下发的媒体密钥域派生，实现端到静态加密；数据库里只存密文路径与 keyVersion。
 */
export class MediaCryptoService {
  private readonly masterKey: Buffer;

  constructor(masterKeyHex: string) {
    const key = Buffer.from(masterKeyHex, 'hex');
    if (key.length !== 32) {
      throw new Error('MEDIA_MASTER_KEY_HEX 必须是 64 位十六进制 (32 字节)');
    }
    this.masterKey = key;
  }

  deriveKey(assetId: string, keyVersion = 1): Buffer {
    return createHash('sha256')
      .update(Buffer.concat([this.masterKey, Buffer.from(`media:v${keyVersion}:${assetId}`)]))
      .digest();
  }

  /** 输出布局: [12B iv][16B tag][ciphertext] */
  encrypt(plain: Buffer, assetId: string, keyVersion = 1): Buffer {
    const iv = createHash('sha256').update(`${assetId}:${Date.now()}:${Math.random()}`).digest().subarray(0, 12);
    const cipher = createCipheriv('aes-256-gcm', this.deriveKey(assetId, keyVersion), iv);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]);
  }

  decrypt(blob: Buffer, assetId: string, keyVersion = 1): Buffer {
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(12, 28);
    const ciphertext = blob.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.deriveKey(assetId, keyVersion), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
