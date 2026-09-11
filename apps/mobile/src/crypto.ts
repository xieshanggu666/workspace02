import CryptoJS from 'crypto-js';
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system';

/**
 * 本地静态加密（敏感录音在手机上也不能以明文存放）。
 *
 * - 首次使用生成 256-bit 主密钥，存进 iOS Keychain / Android Keystore 支撑的
 *   expo-secure-store，不落 AsyncStorage。
 * - 文件使用 AES-256-CBC + PKCS7，密钥经 PBKDF2(每条记录独立盐, 10k 轮) 派生；
 *   文件头格式 "DENC1" + base64(salt) + ":" + base64(iv) + ":" + ciphertext
 *
 * 与服务端的 AES-GCM 是两道独立防线（端侧加密 / 服务端静态加密）。
 */
const MASTER_KEY_STORE = 'media.masterKey.v1';

async function getMasterKey(): Promise<string> {
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

/** 读取明文文件 → 写出 .enc 密文文件，返回密文路径 */
export async function encryptFile(srcUri: string, recordId: string): Promise<string> {
  const master = await getMasterKey();
  const salt = CryptoJS.lib.WordArray.random(16);
  const iv = CryptoJS.lib.WordArray.random(16);
  const key = deriveFileKey(master, salt);

  const b64 = await FileSystem.readAsStringAsync(srcUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const plain = CryptoJS.enc.Base64.parse(b64);
  const cipher = CryptoJS.AES.encrypt(plain, key, { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 });

  const payload =
    'DENC1:' +
    salt.toString(CryptoJS.enc.Base64) +
    ':' +
    iv.toString(CryptoJS.enc.Base64) +
    ':' +
    cipher.ciphertext.toString(CryptoJS.enc.Base64);

  const dest = srcUri.replace(/\.wav$/i, '') + `.${recordId.slice(0, 8)}.enc`;
  await FileSystem.writeAsStringAsync(dest, payload);
  await FileSystem.deleteAsync(srcUri, { idempotent: true });
  return dest;
}

/** 解密 .enc 文件 → 写出临时明文 wav（返回临时路径，用后即删） */
export async function decryptToTempFile(encUri: string, recordId: string): Promise<string> {
  const master = await getMasterKey();
  const payload = await FileSystem.readAsStringAsync(encUri);
  const [magic, saltB64, ivB64, dataB64] = payload.split(':');
  if (magic !== 'DENC1') throw new Error('不是受支持的密文文件');

  const salt = CryptoJS.enc.Base64.parse(saltB64);
  const iv = CryptoJS.enc.Base64.parse(ivB64);
  const key = deriveFileKey(master, salt);
  const cipherParams = CryptoJS.lib.CipherParams.create({
    ciphertext: CryptoJS.enc.Base64.parse(dataB64),
  });
  const decrypted = CryptoJS.AES.decrypt(
    { cipherparams: { iv }, ciphertext: cipherParams.ciphertext } as any,
    key,
    { mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 },
  );

  const tmp = `${FileSystem.cacheDirectory}play-${recordId.slice(0, 8)}.wav`;
  await FileSystem.writeAsStringAsync(tmp, decrypted.toString(CryptoJS.enc.Base64), {
    encoding: FileSystem.EncodingType.Base64,
  });
  return tmp;
}
