import { useRef, useState, useCallback } from 'react';
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import { Audio } from 'expo-av';
import * as Crypto from 'expo-crypto';
import { encryptFile, decryptToTempFile } from './crypto';

export interface RecordingResult {
  id: string;
  /** 加密后的本地文件 uri */
  encUri: string;
  durationSec: number;
  peaks: number[];
  /** 真实音频格式（解密后/上传时使用） */
  ext: 'wav' | 'm4a';
  mime: string;
}

/** iOS 录 LINEARPCM/wav；Android 录 AAC/m4a（系统支持最好） */
export const RECORDING_FORMAT = {
  ext: Platform.OS === 'ios' ? ('wav' as const) : ('m4a' as const),
  mime: Platform.OS === 'ios' ? 'audio/wav' : 'audio/mp4',
};

function recordingOptions() {
  const base = Audio.RecordingOptionsPresets.HIGH_QUALITY;
  if (Platform.OS === 'ios') {
    return {
      ...base,
      isMeteringEnabled: true,
      ios: {
        ...base.ios,
        extension: '.wav',
        outputFormat: Audio.IOSOutputFormat.LINEARPCM,
        audioQuality: Audio.IOSAudioQuality.HIGH,
      },
    };
  }
  return { ...base, isMeteringEnabled: true }; // Android 默认 .m4a / AAC
}

/**
 * 录音采集：
 *  - 录音中每 100ms 回调一次 metering（dB），归一化为 0..1 波形峰值
 *  - 录完立刻本地 AES 加密落盘，明文文件立即删除
 */
export function useFieldRecorder() {
  const recRef = useRef<Audio.Recording | null>(null);
  const peaksRef = useRef<number[]>([]);
  const startedAt = useRef<number>(0);
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const start = useCallback(async () => {
    const perm = await Audio.requestPermissionsAsync();
    if (!perm.granted) throw new Error('未授予麦克风权限');
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });

    peaksRef.current = [];
    startedAt.current = Date.now();
    const { recording } = await Audio.Recording.createAsync(recordingOptions());
    recRef.current = recording;
    setIsRecording(true);

    recording.setProgressUpdateInterval(100);
    recording.setOnRecordingStatusUpdate((status) => {
      if (!status.isRecording) return;
      const db = (status as any).metering ?? -60;
      // -60dB..0dB 线性化到 0..1（指数增强弱信号视觉表现）
      const norm = Math.max(0, Math.min(1, Math.pow((db + 60) / 60, 1.6)));
      peaksRef.current.push(Number(norm.toFixed(3)));
      setElapsed((Date.now() - startedAt.current) / 1000);
    });
  }, []);

  const stop = useCallback(async (): Promise<RecordingResult> => {
    const r = recRef.current;
    if (!r) throw new Error('没有进行中的录音');
    await r.stopAndUnloadAsync();
    const uri = r.getURI();
    setIsRecording(false);
    recRef.current = null;

    const durationSec = (Date.now() - startedAt.current) / 1000;
    const id = `aud-${Crypto.randomUUID()}`;
    const { ext, mime } = RECORDING_FORMAT;
    const finalUri = uri || `${FileSystem.cacheDirectory}${id}.${ext}`;
    const encUri = await encryptFile(finalUri, id);
    return { id, encUri, durationSec: Number(durationSec.toFixed(2)), peaks: peaksRef.current, ext, mime };
  }, []);

  const cancel = useCallback(async () => {
    try {
      await recRef.current?.stopAndUnloadAsync();
    } catch {}
    recRef.current = null;
    setIsRecording(false);
  }, []);

  return { start, stop, cancel, isRecording, elapsed };
}

/** 播放本地加密文件：解密到临时文件后交给系统播放器，播完即删 */
export async function playEncrypted(
  encUri: string,
  id: string,
  ext: 'wav' | 'm4a' = 'wav',
): Promise<Audio.Sound> {
  const tmp = await decryptToTempFile(encUri, id, ext);
  const { sound } = await Audio.Sound.createAsync({ uri: tmp }, { shouldPlay: true });
  sound.setOnPlaybackStatusUpdate((status) => {
    if (status.isLoaded && status.didJustFinish) {
      sound.unloadAsync();
      FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
    }
  });
  return sound;
}
