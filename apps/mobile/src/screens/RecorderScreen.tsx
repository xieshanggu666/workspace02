import React, { useState } from 'react';
import { View, Text, StyleSheet, Alert } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useFieldRecorder } from '../recorder';
import { useStore } from '../store';
import { theme } from '../ui/theme';
import { Button, Card, Tag } from '../ui/bits';
import type { AudioAssetDto } from '@dialect/shared';

/**
 * 现场录音页：
 *  录音结束即本地加密 → 写元数据（status 根据授权状态决定）→ 进 outbox。
 *  无网络时可连续录多条；全部先入队，联网后同步并补传文件。
 */
export function RecorderScreen({ route, navigation }: any) {
  const { speakerId } = route.params as { speakerId?: string };
  const speaker = useStore((s) => (speakerId ? s.speakers[speakerId] : undefined));
  const me = useStore((s) => s.me);
  const upsertLocal = useStore((s) => s.upsertLocal);
  const attachLocalMedia = useStore((s) => s.attachLocalMedia);
  const { start, stop, cancel, isRecording, elapsed } = useFieldRecorder();
  const [busy, setBusy] = useState(false);

  const restrictedByConsent = !speaker || speaker.consentStatus !== 'granted';

  const onStart = async () => {
    try {
      await start();
    } catch (e) {
      Alert.alert('无法录音', String(e));
    }
  };

  const onStop = async () => {
    setBusy(true);
    try {
      const rec = await stop();
      const id = rec.id;
      const sensitive = restrictedByConsent;
      const dto: AudioAssetDto = {
        id,
        title: `${speaker?.dialect || '方言'}录音 ${new Date().toLocaleString()}`,
        speakerId: speaker?.id || 'unknown',
        ownerId: me?.id || 'unknown',
        dialect: speaker?.dialect || '未分类',
        durationSec: rec.durationSec,
        sampleRate: 44100,
        channels: 1,
        mime: rec.mime,
        waveformPeaks: rec.peaks,
        syllables: [],
        status: sensitive ? 'restricted' : 'draft',
        sensitive,
        keyVersion: sensitive ? 1 : null,
        recordedAt: new Date().toISOString(),
        version: 1,
        updatedAt: new Date().toISOString(),
      };
      attachLocalMedia(id, rec.encUri);
      upsertLocal('audio', dto, { localFileUri: rec.encUri, uploadPath: `/audio/${id}/file` });
      Alert.alert(
        sensitive ? '已加密保存（受限）' : '已保存',
        sensitive
          ? '该说话人尚未完成授权，录音已在本地加密，同步前不会以明文存在。'
          : '录音已入采集队列，可立即标注音节。',
      );
      navigation.replace('AssetEditor', { id });
    } catch (e) {
      Alert.alert('保存失败', String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.wrap}>
      <Card>
        <Text style={styles.h2}>
          {speaker ? `为「${speaker.name}」录音` : '自由录音（未绑定说话人）'}
        </Text>
        {speaker && (
          <View style={{ marginTop: 6 }}>
            <Tag
              text={
                speaker.consentStatus === 'granted'
                  ? `已授权 · ${speaker.consentScope}`
                  : speaker.consentStatus === 'revoked'
                    ? '授权已撤回，禁止采集'
                    : '授权待签署：本条将加密受限'
              }
              tone={speaker.consentStatus === 'granted' ? 'ok' : 'warn'}
            />
          </View>
        )}
      </Card>

      <Card style={styles.meter}>
        <Text style={styles.timer}>{elapsed.toFixed(1)} s</Text>
        <View style={[styles.dot, { backgroundColor: isRecording ? theme.color.danger : '#bbb' }]} />
        {speaker?.consentStatus === 'revoked' ? (
          <Text style={styles.warn}>该说话人已撤回授权，不能继续采集。</Text>
        ) : isRecording ? (
          <Button title="■ 停止并加密保存" variant="danger" onPress={onStop} disabled={busy} />
        ) : (
          <Button title="● 开始录音" variant="ok" onPress={onStart} disabled={busy} />
        )}
        {isRecording && <Button title="取消（不保存）" variant="ghost" onPress={cancel} />}
      </Card>

      <Text style={styles.footnote}>
        录音期间自动采集电平生成波形；停止后明文文件立即删除，仅保留 AES 密文。
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.color.bg, paddingTop: 8 },
  h2: { fontSize: 16, fontWeight: '700' },
  meter: { alignItems: 'center', paddingVertical: 28 },
  timer: { fontSize: 44, fontWeight: '800', color: theme.color.primary, fontVariant: ['tabular-nums'] },
  dot: { width: 12, height: 12, borderRadius: 6, marginVertical: 16 },
  warn: { color: theme.color.danger, textAlign: 'center', marginVertical: 10 },
  footnote: { color: theme.color.subtext, fontSize: 12, textAlign: 'center', marginHorizontal: 30 },
});
