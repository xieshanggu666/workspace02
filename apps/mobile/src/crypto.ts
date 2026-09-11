import CryptoJS from 'crypto-js';
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system';

export const ENC_MAGIC = 'DENC1';

/**
 * 本地静态加密（敏感录音在手机上也不能以明文存放）。
 *
 * - 首次使用生成 256-bit 主密钥，存进 iOS Keychain / Android Keystore 支撑的
 *   expo-secure-store，不落 AsyncStorage。
 * - 文件使用 AES-256-CBC + PKCS7，密钥经 PBKDF2(每条记录独立盐, 10k 轮) 派生；
 *   容器格式 "DENC1" + base64(salt) + ":" + base64(iv) + ":" + base64(ciphertext)
 *
 * 与服务端的 AES-GCM 是两道独立防线（端侧加密 / 服务端静态加密）。
 */
const MASTER_KEY_STORE = 'media.masterKey.v1';

export async function getMasterKey(): Promise<string> {
  let key = await SecureStore.getItemAsync(MASTER_KEY_STORE);
  if (!key) {
    key = CryptoJS.lib.WordArray.random(32).toString(CryptoJS.enc.Hex);
    await SecureStore.setItemAsync(MASTER_KEY_STORE, key);
  }
  return key;
}

function deriveFileKey(masterHex: string, salt: CryptoJS.lib.WordArray) {
  return CryptoJS.PBKDF2(masterHex, salt, { keySize: 256 / 32, iterations: 10_000 });
}

export interface SealedPayload {
  saltB64: string;
  ivB64: string;
  dataB64: string;
}

/** 纯函数：明文 base64 → 容器各段（便于 vitest 覆盖，不依赖原生模块） */
export function sealBase64(plainB64: string, masterHex: string): SealedPayload {
  const salt = CryptoJS.lib.WordArray.random(16);
  const iv = CryptoJS.lib.WordArray.random(16);
  const key = deriveFileKey(masterHex, salt);
  const cipher = CryptoJS.AES.encrypt(CryptoJS.enc.Base64.parse(plainB64), key, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });
  return {
    saltB64: salt.toString(CryptoJS.enc.Base64),
    ivB64: iv.toString(CryptoJS.enc.Base64),
    dataB64: cipher.ciphertext.toString(CryptoJS.enc.Base64),
  };
}

/** 纯函数：容器各段 → 明文 base64。必须用正规 CipherParams，不能手拼对象 */
export function openPayload(p: SealedPayload, masterHex: string): string {
  const salt = CryptoJS.enc.Base64.parse(p.saltB64);
  const iv = CryptoJS.enc.Base64.parse(p.ivB64);
  const key = deriveFileKey(masterHex, salt);
  const cipherParams = CryptoJS.lib.CipherParams.create({
    ciphertext: CryptoJS.enc.Base64.parse(p.dataB64),
  });
  const decrypted = CryptoJS.AES.decrypt(cipherParams, key, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });
  return decrypted.toString(CryptoJS.enc.Base64);
}

export function encodeContainer(p: SealedPayload): string {
  return `${ENC_MAGIC}:${p.saltB64}:${p.ivB64}:${p.dataB64}`;
}

export function decodeContainer(payload: string): SealedPayload {
  const [magic, saltB64, ivB64, dataB64] = payload.split(':');
  if (magic !== ENC_MAGIC || !saltB64 || !ivB64 || !dataB64) {
    throw new Error('不是受支持的密文文件');
  }
  return { saltB64, ivB64, dataB64 };
}

/** 读取明文文件 → 写出 .enc 密文文件，返回密文路径 */
export async function encryptFile(srcUri: string, recordId: string): Promise<string> {
  const master = await getMasterKey();
  const b64 = await FileSystem.readAsStringAsync(srcUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const dest = encUriFor(srcUri, recordId);
  await FileSystem.writeAsStringAsync(dest, encodeContainer(sealBase64(b64, master)));
  await FileSystem.deleteAsync(srcUri, { idempotent: true });
  return dest;
}

/**
 * 解密 .enc 文件 → 写出临时明文音频文件（用后即删）。
 * ext 决定播放/上传时的真实格式（iOS wav、Android m4a）。
 */
export async function decryptToTempFile(
  encUri: string,
  recordId: string,
  ext = 'wav',
): Promise<string> {
  const master = await getMasterKey();
  const plainB64 = openPayload(decodeContainer(await FileSystem.readAsStringAsync(encUri)), master);
  const tmp = `${FileSystem.cacheDirectory}play-${recordId.slice(0, 8)}.${ext}`;
  await FileSystem.writeAsStringAsync(tmp, plainB64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return tmp;
}

/**
 * 同步上传前解密成临时【明文】文件。上传的必须是可播放的原始录音，
 * 绝不能把 DENC1 密文容器当成 wav/m4a 直传；是否在服务端落密文由服务端按
 * 授权状态决定（一录一密 AES-GCM）。
 */
export async function decryptToUploadFile(
  encUri: string,
  recordId: string,
  ext = 'wav',
): Promise<{ plainUri: string; cleanup: () => Promise<void> }> {
  const plainUri = await decryptToTempFile(encUri, `up-${recordId}`, ext);
  return {
    plainUri,
    cleanup: async () => {
      await FileSystem.deleteAsync(plainUri, { idempotent: true });
    },
  };
}

export function encUriFor(srcUri: string, recordId: string): string {
  return srcUri.replace(/\.(wav|m4a|aac)$/i, '') + `.${recordId.slice(0, 8)}.enc`;
}
