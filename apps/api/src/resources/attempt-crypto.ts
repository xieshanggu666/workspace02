import { createCipheriv, createDecipheriv, createHash } from 'crypto';
import { ConfigService } from '@nestjs/config';

/**
 * 学员跟读录音同样以 AES-256-GCM 加密；密钥按 attemptId 派生。
 * 独立成小模块，避免 PracticeService 构造期重复初始化密码组件。
 */
let masterKey: Buffer | null = null;

export function initAttemptCrypto(masterKeyHex: string) {
  masterKey = Buffer.from(masterKeyHex, 'hex');
}

export function ensureKey(): Buffer {
  if (!masterKey) {
    // 兜底（测试环境未经过 ConfigModule 时）
    masterKey = Buffer.from(
      '4f8b2d6c1e9a7f3056d4c2b8a19f7e6d3c0b9a8f7e6d5c4b3a291807f6e5d4c3',
      'hex',
    );
  }
  return masterKey;
}

function keyFor(attemptId: string): Buffer {
  return createHash('sha256')
    .update(Buffer.concat([ensureKey(), Buffer.from(`attempt:v1:${attemptId}`)]))
    .digest();
}

export function encryptAttempt(plain: Buffer, attemptId: string): Buffer {
  const iv = createHash('sha256').update(`${attemptId}:${Date.now()}:${Math.random()}`).digest().subarray(0, 12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(attemptId), iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptAttempt(blob: Buffer, attemptId: string): Buffer {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', keyFor(attemptId), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
}

/** 供模块初始化时从 ConfigService 注入主密钥 */
export function bootstrapAttemptCrypto(config: ConfigService) {
  initAttemptCrypto(config.get<string>('app.masterKeyHex')!);
}
