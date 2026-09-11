import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

/**
 * 全局配置。
 * API 地址可在“同步”页里覆盖（保存到 SecureStore，不进明文存储）。
 * 真机调试时改成局域网地址，例如 http://192.168.1.10:3000/api
 */
export const DEFAULT_API_BASE =
  (Constants.expoConfig?.extra?.apiBase as string) || 'http://127.0.0.1:3000/api';

const KEY_API_BASE = 'cfg.apiBase';

export async function getApiBase(): Promise<string> {
  return (await SecureStore.getItemAsync(KEY_API_BASE)) || DEFAULT_API_BASE;
}

export async function setApiBase(v: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_API_BASE, v.replace(/\/$/, ''));
}

/** 设备唯一标识（用于同步的 deviceId） */
const KEY_DEVICE_ID = 'cfg.deviceId';
export async function getDeviceId(): Promise<string> {
  let id = await SecureStore.getItemAsync(KEY_DEVICE_ID);
  if (!id) {
    id = `dev-${Crypto.randomUUID()}`;
    await SecureStore.setItemAsync(KEY_DEVICE_ID, id);
  }
  return id;
}
