import { describe, expect, it } from 'vitest';
import { MediaCryptoService } from '../src/media/media-crypto.service';
import { encryptAttempt, decryptAttempt } from '../src/resources/attempt-crypto';
import { generateWavBuffer } from '../src/seeds/generate-wavs';

const KEY = '4f8b2d6c1e9a7f3056d4c2b8a19f7e6d3c0b9a8f7e6d5c4b3a291807f6e5d4c3';

describe('MediaCryptoService AES-256-GCM', () => {
  const svc = new MediaCryptoService(KEY);

  it('加密后磁盘上找不到明文片段，且可正确解密', () => {
    const plain = Buffer.from('SENSITIVE-CANTONESE-RECORDING-你好');
    const blob = svc.encrypt(plain, 'aud-1', 1);
    expect(blob.includes(plain)).toBe(false);
    expect(svc.decrypt(blob, 'aud-1', 1).equals(plain)).toBe(true);
  });

  it('篡改密文会被 GCM 认证标签识破', () => {
    const blob = svc.encrypt(Buffer.from('hello world'), 'aud-1', 1);
    blob[blob.length - 1] ^= 0xff;
    expect(() => svc.decrypt(blob, 'aud-1', 1)).toThrow();
  });

  it('用错误的 assetId 派生密钥无法解密', () => {
    const blob = svc.encrypt(Buffer.from('secret'), 'aud-right', 1);
    expect(() => svc.decrypt(blob, 'aud-wrong', 1)).toThrow();
  });

  it('拒绝长度不为 32 字节的主密钥', () => {
    expect(() => new MediaCryptoService('abcd')).toThrow();
  });

  it('学员跟读录音加密往返一致', () => {
    const plain = Buffer.from([0, 1, 2, 3, 250, 251, 252]);
    const enc = encryptAttempt(plain, 'att-9');
    expect(decryptAttempt(enc, 'att-9').equals(plain)).toBe(true);
  });
});

describe('generateWavBuffer', () => {
  it('生成合法 WAV 头且峰值落在 0..1，长度与帧率匹配', () => {
    const { buffer, peaks } = generateWavBuffer(
      [{ start: 0, end: 0.3, label: 'a' }],
      0.5,
      200,
      16000,
    );
    expect(buffer.toString('ascii', 0, 4)).toBe('RIFF');
    expect(buffer.toString('ascii', 8, 12)).toBe('WAVE');
    expect(buffer.readUInt32LE(24)).toBe(16000);
    expect(peaks.length).toBe(50); // 0.5s / 10ms
    expect(peaks.every((p) => p >= 0 && p <= 1)).toBe(true);
    // 发声段有能量
    expect(Math.max(...peaks.slice(0, 30))).toBeGreaterThan(0.1);
  });
});
