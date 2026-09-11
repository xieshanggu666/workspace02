import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert, TextInput } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system';
import { Audio } from 'expo-av';
import { useFieldRecorder } from '../recorder';
import { useStore } from '../store';
import { api } from '../api';
import { theme } from '../ui/theme';
import { Button, Card, Tag } from '../ui/bits';
import { Waveform } from '../ui/Waveform';
import type { PracticeAttemptDto } from '@dialect/shared';

/**
 * 课程详情/练习页：
 *  - 学员：逐句听原音 → 录音跟读（本地加密）→ 提交为 attempt（进入 outbox 同步+补传）
 *  - 教练：查看每句收到的学员跟读
 */
export function CourseDetailScreen({ route, navigation }: any) {
  const { id } = route.params as { id: string };
  const course = useStore((s) => s.courses[id]);
  const allItems = useStore((s) =>
    Object.values(s.courseItems)
      .filter((i) => i.courseId === id && !i.deletedAt)
      .sort((a, b) => a.orderIndex - b.orderIndex),
  );
  const assets = useStore((s) => s.audio);
  const speakers = useStore((s) => s.speakers);
  const me = useStore((s) => s.me);
  const attempts = useStore((s) =>
    Object.values(s.attempts)
      .filter((a) => !a.deletedAt && allItems.some((i) => i.id === a.courseItemId))
      // 学员只看本人提交；服务端 sync/pull 已按账号过滤，这里再兜底一层
      .filter((a) => (me?.role === 'student' ? a.studentId === me.id : true))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
  );

  const [activeItem, setActiveItem] = useState<string | null>(null);
  const [lastAttempt, setLastAttempt] = useState<PracticeAttemptDto | null>(null);
  const { start, stop, isRecording, elapsed } = useFieldRecorder();
  const upsertLocal = useStore((s) => s.upsertLocal);

  if (!course) return <View style={styles.wrap}><Text>课程不存在</Text></View>;

  const playOriginal = async (audioId: string) => {
    try {
      const dest = `${FileSystem.cacheDirectory}orig-${audioId}.wav`;
      await api.downloadFile(`/audio/${audioId}/file`, dest);
      const { sound } = await Audio.Sound.createAsync({ uri: dest }, { shouldPlay: true });
      sound.setOnPlaybackStatusUpdate((st) => st.isLoaded && st.didJustFinish && sound.unloadAsync());
    } catch (e: any) {
      Alert.alert('原音不可用', e?.message || String(e));
    }
  };

  const beginAttempt = async (courseItemId: string) => {
    try {
      setActiveItem(courseItemId);
      await start();
    } catch (e) {
      Alert.alert('录音失败', String(e));
    }
  };

  const finishAttempt = async () => {
    const item = allItems.find((i) => i.id === activeItem);
    if (!item) return;
    try {
      const rec = await stop();
      const dto: PracticeAttemptDto = {
        id: `att-${Crypto.randomUUID()}`,
        studentId: me?.id || 'unknown',
        courseItemId: item.id,
        audioId: item.audioId,
        durationSec: rec.durationSec,
        waveformPeaks: rec.peaks,
        score: null,
        createdAt: new Date().toISOString(),
        version: 1,
        updatedAt: new Date().toISOString(),
      };
      upsertLocal('attempts', dto, { localFileUri: rec.encUri });
      setLastAttempt(dto);
      Alert.alert('跟读已加密保存', '将在同步时上传给教练。');
    } catch (e) {
      Alert.alert('保存失败', String(e));
    } finally {
      setActiveItem(null);
    }
  };

  return (
    <ScrollView style={styles.wrap}>
      <Card>
        <Text style={styles.h2}>{course.title}</Text>
        <Text style={styles.meta}>{course.description}</Text>
        {(me?.role === 'coach' || me?.role === 'admin') && (
          <Button title="编辑课程" small variant="ghost" onPress={() => navigation.navigate('CourseEditor', { id })} />
        )}
      </Card>

      {allItems.map((item, idx) => {
        const asset = assets[item.audioId];
        const spk = asset ? speakers[asset.speakerId] : undefined;
        const isRecordingThis = isRecording && activeItem === item.id;
        return (
          <Card key={item.id}>
            <View style={styles.row}>
              <Text style={{ fontWeight: '700', flex: 1 }}>
                {idx + 1}. {asset?.title || item.audioId}
              </Text>
              <Tag text={asset?.dialect || ''} />
            </View>
            <Text style={styles.meta}>
              {spk?.name} · {asset?.transcript}
              {asset?.ipa ? `  [${asset.ipa}]` : ''}
            </Text>
            {item.coachTip ? <Text style={styles.tip}>教练提示：{item.coachTip}</Text> : null}

            <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
              <Button title="▶ 听原音" small variant="ghost" onPress={() => playOriginal(item.audioId)} />
              {me?.role === 'student' && !isRecording && (
                <Button title={`● 跟读（×${item.repeatTimes}）`} small variant="ok" onPress={() => beginAttempt(item.id)} />
              )}
            </View>

            {isRecordingThis && (
              <View style={{ marginTop: 8 }}>
                <Text style={{ color: theme.color.danger, fontWeight: '700' }}>录音中 {elapsed.toFixed(1)}s</Text>
                <Button title="■ 停止并加密提交" small variant="danger" onPress={finishAttempt} />
              </View>
            )}
          </Card>
        );
      })}

      <Card>
        <Text style={styles.h2}>
          {me?.role === 'student' ? '我的提交' : `学员跟读（${attempts.length}）`}
        </Text>
        {attempts.length === 0 && <Text style={styles.meta}>暂无提交</Text>}
        {attempts.map((a) => (
          <AttemptRow key={a.id} attempt={a} canAnnotate={me?.role === 'coach' || me?.role === 'admin'} />
        ))}
        {lastAttempt && attempts.length === 0 && (
          <Text style={styles.meta}>刚提交的跟读将在同步后出现在这里。</Text>
        )}
      </Card>
    </ScrollView>
  );
}

function AttemptRow({ attempt, canAnnotate }: { attempt: PracticeAttemptDto; canAnnotate: boolean }) {
  const annotations = useStore((s) =>
    Object.values(s.annotations).filter((x) => x.attemptId === attempt.id && !x.deletedAt),
  );
  const upsertLocal = useStore((s) => s.upsertLocal);
  const [comment, setComment] = useState('');
  const [atSec, setAtSec] = useState('0');

  const addAnnotation = () => {
    if (!comment.trim()) return;
    upsertLocal('annotations', {
      id: `ann-${Crypto.randomUUID()}`,
      attemptId: attempt.id,
      coachId: 'me',
      atSec: Number(atSec) || 0,
      comment: comment.trim(),
      rating: null,
      version: 1,
      updatedAt: new Date().toISOString(),
    });
    setComment('');
  };

  return (
    <View style={{ borderTopWidth: 1, borderTopColor: theme.color.border, paddingVertical: 8 }}>
      <Text style={styles.meta}>
        {new Date(attempt.createdAt).toLocaleString()} · {attempt.durationSec.toFixed(1)}s
      </Text>
      <Waveform peaks={attempt.waveformPeaks} durationSec={attempt.durationSec} syllables={[]} height={56} />
      {annotations.map((an) => (
        <View key={an.id} style={{ flexDirection: 'row', marginTop: 4 }}>
          <Tag text={`${an.atSec.toFixed(1)}s`} tone="accent" />
          <Text style={{ flex: 1, fontSize: 13 }}>{an.comment}</Text>
        </View>
      ))}
      {canAnnotate && (
        <View style={{ marginTop: 6 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput
              style={[styles.input, { width: 70 }]}
              keyboardType="numeric"
              value={atSec}
              onChangeText={setAtSec}
              placeholder="秒"
            />
            <TextInput
              style={[styles.input, { flex: 1 }]}
              value={comment}
              onChangeText={setComment}
              placeholder="教练批注，如：这个入声收得再快一点"
            />
          </View>
          <Button title="添加批注" small onPress={addAnnotation} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.color.bg },
  h2: { fontWeight: '700', fontSize: 15, marginBottom: 4 },
  meta: { color: theme.color.subtext, fontSize: 12, marginTop: 2 },
  tip: { color: theme.color.warn, fontSize: 12, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center' },
  input: {
    borderWidth: 1, borderColor: theme.color.border, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#fff',
  },
});
