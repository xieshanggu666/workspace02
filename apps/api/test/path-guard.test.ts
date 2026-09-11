import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { isSafeMediaRelativePath, resolveWithinStorage } from '../src/media/path-guard';

const ROOT = '/srv/app/uploads';

describe('path-guard', () => {
  it('接受服务端生成的合法媒体相对路径', () => {
    expect(isSafeMediaRelativePath('audio/aud-1.wav')).toBe(true);
    expect(isSafeMediaRelativePath('audio/aud-1.m4a.enc')).toBe(true);
    expect(isSafeMediaRelativePath('attempts/att-2.wav.enc')).toBe(true);
    expect(isSafeMediaRelativePath('attempts/att-x_1.m4a')).toBe(true);
  });

  it('拒绝路径穿越与绝对路径', () => {
    for (const evil of [
      '../../etc/passwd',
      'audio/../../../.env',
      '/etc/passwd',
      'audio/aud-1.wav/../../../x',
      'audio/../audio-secret/key',
      'audio/a.wav\x00.png',
      'audio/',
      'unknown/x.wav',
      '',
      null,
      undefined,
    ]) {
      expect(isSafeMediaRelativePath(evil as any)).toBe(false);
      expect(() => resolveWithinStorage(ROOT, evil as any)).toThrow();
    }
  });

  it('合法路径解析结果必须在存储根目录内', () => {
    const abs = resolveWithinStorage(ROOT, 'audio/aud-1.wav.enc');
    expect(abs).toBe(path.resolve(ROOT, 'audio/aud-1.wav.enc'));
    expect(abs.startsWith(ROOT)).toBe(true);
  });

  it('拒绝奇怪扩展名或带分隔符的伪造 id', () => {
    expect(isSafeMediaRelativePath('audio/..%2f..%2f.wav')).toBe(false);
    expect(isSafeMediaRelativePath('audio/id.wav/../../x')).toBe(false);
  });
});
