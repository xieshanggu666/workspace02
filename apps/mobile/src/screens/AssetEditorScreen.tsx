import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView, Alert } from 'react-native';
import * as FileSystem from 'expo-file-system';
import { Audio } from 'expo-av';
import { useStore } from '../store';
import { playEncrypted } from '../recorder';
import { api } from '../api';
import { theme } from '../ui/theme';
import { Button, Card, Field, Tag } from '../ui/bits';
import { Waveform } from '../ui/Waveform';

/**
 * 音频标注页：
 *  - 波形上点边界点，连续两点构成一个音节，可逐音节填转写/对译
 *  - 整句转写、普通话对译、IPA 字段
 *  - 播放优先用本地加密文件（现场刚录的），否则从服务端下载（过授权闸门）
 */
export function AssetEditorScreen({ route }: any) {
  const { id } = route.params as { id: string };
  const asset = useStore((s) => s.audio[id]);
  const speaker = useStore((s) => (asset ? s.speakers[asset.speakerId] : undefined));
  const localEnc = useStore((s) => s.localMedia[id]);
  const upsertLocal = useStore((s) => s.upsertLocal);

  const [title, setTitle] = useState(asset?.title || '');
  const [transcript, setTranscript] = useState(asset?.transcript || '');
  const [translation, setTranslation] = useState(asset?.translation || '');
  const [ipa, setIpa] = useState(asset?.ipa || '');
  const [boundaries, setBoundaries] = useState<number[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [glosses, setGlosses] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // 已保存的音节恢复为边界点
  useEffect(() => {
    if (asset?.syllables?.length) {
      const b: number[] = [];
      asset.syllables.forEach((s) => b.push(s.start, s.end));
      setBoundaries(b);
      setLabels(asset.syllables.map((s) => s.label));
      setGlosses(asset.syllables.map((s) => s.gloss || ''));
    }
  }, [id]);

  const syllablesPreview = useMemo(() => buildSyllables(boundaries, labels, glosses), [boundaries, labels, glosses]);

  if (!asset) return <View style={styles.wrap}><Text>素材不存在（可能尚未同步）</Text></View>;

  const onWavePress = (sec: number) => {
    setBoundaries((prev) => {
      const next = [...prev, sec].sort((a, b) => a - b);
      setLabels((l) => Array.from({ length: Math.floor(next.length / 2) }, (_, i) => l[i] || ''));
      setGlosses((g) => Array.from({ length: Math.floor(next.length / 2) }, (_, i) => g[i] || ''));
      return next;
    });
  };

  const removeSyllable = (idx: number) => {
    const b = [...boundaries];
    b.splice(idx * 2, 2);
    setBoundaries(b);
    setLabels((l) => l.filter((_, i) => i !== idx));
    setGlosses((g) => g.filter((_, i) => i !== idx));
  };

  const play = async () => {
    try {
      const ext: 'wav' | 'm4a' =
        asset.mime === 'audio/mp4' || asset.mime === 'audio/m4a' || asset.mime === 'audio/aac'
          ? 'm4a'
          : 'wav';
      if (localEnc) {
        // 本地刚录的：DENC1 密文先解密成临时明文再播
        await playEncrypted(localEnc, id, ext);
        return;
      }
      // 远端：服务端解密并过授权闸门后返回明文，扩展名要匹配真实格式
      setBusy(true);
      const dest = `${FileSystem.cacheDirectory}remote-${id}.${ext}`;
      await api.downloadFile(`/audio/${id}/file`, dest);
      const { sound } = await Audio.Sound.createAsync({ uri: dest }, { shouldPlay: true });
      sound.setOnPlaybackStatusUpdate((st) => {
        if (st.isLoaded && st.didJustFinish) sound.unloadAsync();
      });
    } catch (e: any) {
      Alert.alert('无法播放', e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const status = syllablesPreview.length > 0 && transcript ? 'annotated' : asset.status;
    upsertLocal('audio', {
      ...asset,
      title: title.trim() || asset.title,
      transcript: transcript || null,
      translation: translation || null,
      ipa: ipa || null,
      syllables: syllablesPreview,
      status: asset.status === 'restricted' ? 'restricted' : status,
    });
    Alert.alert('已保存到本地', '将在下次同步时按版本合并到服务器。');
  };

  return (
    <ScrollView style={styles.wrap}>
      <Card>
        <View style={styles.row}>
          <Tag text={asset.status} tone={asset.status === 'restricted' ? 'danger' : asset.status === 'published' ? 'ok' : 'default'} />
          {asset.sensitive && <Tag text="本地+服务端加密" tone="warn" />}
        </View>
        <Text style={styles.meta}>{asset.dialect} · {speaker?.name || asset.speakerId} · {asset.durationSec.toFixed(1)}s</Text>
        <Button title={busy ? '准备播放…' : '▶ 试听'} small onPress={play} />
      </Card>

      <Card>
        <Text style={styles.section}>波形 / 音节切分</Text>
        <Waveform
          peaks={asset.waveformPeaks || [0.1, 0.3, 0.5, 0.2]}
          durationSec={asset.durationSec}
          syllables={syllablesPreview}
          editable
          onToggleMark={onWavePress}
          onRemoveMark={removeSyllable}
        />
      </Card>

      <Card>
        {syllablesPreview.map((s, i) => (
          <View key={i} style={{ marginBottom: 8 }}>
            <Text style={styles.meta}>音节 {i + 1}（{s.start.toFixed(2)}–{s.end.toFixed(2)}s）</Text>
            <TextInput
              style={styles.input}
              placeholder="转写/IPA，如 nei˨˧"
              value={labels[i] || ''}
              onChangeText={(t) => setLabels((l) => l.map((x, j) => (j === i ? t : x)))}
            />
            <TextInput
              style={styles.input}
              placeholder="普通话对译，如 你"
              value={glosses[i] || ''}
              onChangeText={(t) => setGlosses((g) => g.map((x, j) => (j === i ? t : x)))}
            />
          </View>
        ))}
      </Card>

      <Card>
        <Field label="标题">
          <TextInput style={styles.input} value={title} onChangeText={setTitle} />
        </Field>
        <Field label="整句转写">
          <TextInput style={styles.input} value={transcript || ''} onChangeText={setTranscript} />
        </Field>
        <Field label="普通话对译">
          <TextInput style={styles.input} value={translation || ''} onChangeText={setTranslation} />
        </Field>
        <Field label="IPA 整句">
          <TextInput style={styles.input} value={ipa || ''} onChangeText={setIpa} />
        </Field>
        <Button title="保存标注（入同步队列）" onPress={save} />
      </Card>
    </ScrollView>
  );
}

function buildSyllables(boundaries: number[], labels: string[], glosses: string[]) {
  const out: { start: number; end: number; label: string; gloss?: string }[] = [];
  for (let i = 0; i + 1 < boundaries.length; i += 2) {
    out.push({
      start: boundaries[i],
      end: boundaries[i + 1],
      label: labels[i / 2] || `音节${i / 2 + 1}`,
      gloss: glosses[i / 2] || undefined,
    });
  }
  return out;
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.color.bg },
  row: { flexDirection: 'row', marginBottom: 6 },
  meta: { color: theme.color.subtext, fontSize: 12, marginVertical: 4 },
  section: { fontWeight: '700', marginBottom: 8 },
  input: {
    borderWidth: 1, borderColor: theme.color.border, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 8, marginBottom: 6, backgroundColor: '#fff',
  },
});
