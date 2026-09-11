import { describe, expect, it, vi } from 'vitest';

// 原生模块在 node 测试环境下用内存桩替代
const files = new Map<string, string>();
vi.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: (k: string) => Promise.resolve(store.get(k) ?? null),
    setItemAsync: (k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve();
    },
  };
});
vi.mock('expo-file-system', () => ({
  EncodingType: { Base64: 'base64' },
  cacheDirectory: '/tmp/cache/',
  readAsStringAsync: (uri: string) => Promise.resolve(files.get(uri) ?? ''),
  writeAsStringAsync: (uri: string, content: string) => {
    files.set(uri, content);
    return Promise.resolve();
  },
  deleteAsync: (uri: string) => {
    files.delete(uri);
    return Promise.resolve();
  },
}));

const cryptoModule = await import('./crypto');
const { sealBase64, openPayload, encodeContainer, decodeContainer, encryptFile, decryptToTempFile } = cryptoModule;

const MASTER = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('本地音频容器 DENC1（seal/open 纯函数）', () => {
  it('任意二进制往返一致（含 WAV 头）', () => {
    const raw = Buffer.concat([
      Buffer.from('RIFF\x00\x00\x00\x00WAVE'),
      Buffer.from(Array.from({ length: 500 }, (_, i) => i % 256)),
    ]);
    const b64 = raw.toString('base64');
    const sealed = sealBase64(b64, MASTER);
    const opened = openPayload(sealed, MASTER);
    expect(opened).toBe(b64);
    expect(Buffer.from(opened, 'base64').equals(raw)).toBe(true);
  });

  it('密文容器不含明文 WAV 头', () => {
    const sealed = sealBase64(Buffer.from('RIFF\x00\x00\x00\x00WAVE-secret').toString('base64'), MASTER);
    const container = encodeContainer(sealed);
    expect(container.startsWith('DENC1:')).toBe(true);
    expect(container).not.toContain('RIFF');
  });

  it('错误主密钥解出乱码（PKCS7 失败或内容不一致）', () => {
    const sealed = sealBase64(Buffer.from('dialect-recording').toString('base64'), MASTER);
    const wrong = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    let fails = false;
    try {
      const out = openPayload(sealed, wrong);
      fails = out !== Buffer.from('dialect-recording').toString('base64');
    } catch {
      fails = true;
    }
    expect(fails).toBe(true);
  });

  it('容器损坏/魔数错误会被拒绝', () => {
    expect(() => decodeContainer('RIFF:xxxx:yyyy:zzzz')).toThrow();
    expect(() => decodeContainer('DENC1:only-two')).toThrow();
  });
});

describe('文件级加解密（mock 原生文件系统）', () => {
  it('encryptFile 删除明文、写出密文；decryptToTempFile 还原出可播放明文', async () => {
    const raw = Buffer.from('RIFF\x00\x00\x00\x00WAVE-test-audio');
    files.set('/tmp/cache/rec-1.wav', raw.toString('base64'));

    const encUri = await encryptFile('/tmp/cache/rec-1.wav', 'aud-1');
    expect(encUri.endsWith('.enc')).toBe(true);
    expect(files.has('/tmp/cache/rec-1.wav')).toBe(false); // 明文已删
    const container = files.get(encUri)!;
    expect(container.startsWith('DENC1:')).toBe(true);
    expect(container).not.toContain('RIFF');

    const tmp = await decryptToTempFile(encUri, 'aud-1', 'wav');
    expect(tmp).toBe('/tmp/cache/play-aud-1.wav');
    const restored = Buffer.from(files.get(tmp)!, 'base64');
    expect(restored.toString()).toBe('RIFF\x00\x00\x00\x00WAVE-test-audio');
  });
});
