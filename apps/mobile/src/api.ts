import AsyncStorage from '@react-native-async-storage/async-storage';
import type { LoginResponse, SyncPullResult, SyncPushPayload, SyncPushResult } from '@dialect/shared';
import { getApiBase } from './config';

const TOKEN_STORE = 'auth.token';

let memoryToken: string | null = null;

export async function getToken(): Promise<string | null> {
  if (memoryToken) return memoryToken;
  memoryToken = await AsyncStorage.getItem(TOKEN_STORE);
  return memoryToken;
}

export async function setToken(token: string | null) {
  memoryToken = token;
  if (token) await AsyncStorage.setItem(TOKEN_STORE, token);
  else await AsyncStorage.removeItem(TOKEN_STORE);
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const base = await getApiBase();
  const token = await getToken();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).message || detail;
    } catch {}
    throw new ApiError(res.status, typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),

  login: async (username: string, password: string, deviceId: string): Promise<LoginResponse> =>
    request('POST', '/auth/login', { username, password, deviceId }),

  pull: (cursor?: string) =>
    request<SyncPullResult>('GET', `/sync/pull${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),

  push: (payload: SyncPushPayload) => request<SyncPushResult>('POST', '/sync/push', payload),

  /**
   * 上传录音二进制（multipart）。
   * 调用方必须传【明文】临时文件（本地密文先解密）；ext 决定文件名与 MIME。
   * 敏感与否由服务端按元数据决定是否再次静态加密。
   */
  uploadFile: async (
    path: string,
    fileUri: string,
    fieldName: 'file',
    ext: 'wav' | 'm4a' = 'wav',
  ): Promise<void> => {
    const base = await getApiBase();
    const token = await getToken();
    const mime = ext === 'm4a' ? 'audio/mp4' : 'audio/wav';
    const form = new FormData();
    form.append(fieldName, {
      uri: fileUri,
      name: `${fieldName}.${ext}`,
      type: mime,
    } as any);
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      // 不手动设置 Content-Type：RN 需要自己写入 multipart boundary
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: form,
    });
    if (!res.ok) throw new ApiError(res.status, await res.text());
  },

  /** 下载媒体，返回 { uri, mime }（服务端已过授权闸门并解密） */
  downloadFile: async (
    mediaPath: string,
    destUri: string,
  ): Promise<{ uri: string; mime: string }> => {
    const base = await getApiBase();
    const token = await getToken();
    const res = await fetch(`${base}${mediaPath}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, `下载失败 ${res.status}`);
    const mime = res.headers.get('content-type') || 'audio/wav';
    const blob = await res.blob();
    const reader = new FileReader();
    const b64: string = await new Promise((resolve, reject) => {
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const FileSystem = require('expo-file-system');
    await FileSystem.writeAsStringAsync(destUri, b64, { encoding: FileSystem.EncodingType.Base64 });
    return { uri: destUri, mime };
  },
};
