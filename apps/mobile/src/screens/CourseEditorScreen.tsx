import React, { useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, TextInput, Alert } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useStore } from '../store';
import { theme } from '../ui/theme';
import { Button, Card, Tag } from '../ui/bits';
import type { CourseDto, CourseItemDto } from '@dialect/shared';

/**
 * 课程编排（教练）：从已标注素材里挑句子、排序、设置跟读次数与教练提示。
 * 保存时把课程与每个课目都写进 outbox，离线也能编排。
 */
export function CourseEditorScreen({ route, navigation }: any) {
  const existingId = route.params?.id as string | undefined;
  const existing = useStore((s) => (existingId ? s.courses[existingId] : undefined));
  const me = useStore((s) => s.me);
  const allItems = useStore((s) => s.courseItems);
  const assets = useStore((s) =>
    Object.values(s.audio)
      .filter((a) => !a.deletedAt && a.status !== 'restricted')
      .sort((x, y) => x.title.localeCompare(y.title)),
  );
  const upsertLocal = useStore((s) => s.upsertLocal);

  const [title, setTitle] = useState(existing?.title || '');
  const [description, setDescription] = useState(existing?.description || '');
  const [picked, setPicked] = useState<string[]>(
    existing
      ? Object.values(allItems)
          .filter((i) => i.courseId === existing.id && !i.deletedAt)
          .sort((a, b) => a.orderIndex - b.orderIndex)
          .map((i) => i.audioId)
      : [],
  );
  const [tips, setTips] = useState<Record<string, string>>(() => {
    if (!existing) return {};
    const map: Record<string, string> = {};
    for (const i of Object.values(allItems)) {
      if (i.courseId === existing.id && !i.deletedAt && i.coachTip) map[i.audioId] = i.coachTip;
    }
    return map;
  });

  const courseId = existingId || `crs-${Crypto.randomUUID()}`;

  const togglePick = (audioId: string) => {
    setPicked((p) => (p.includes(audioId) ? p.filter((x) => x !== audioId) : [...p, audioId]));
  };

  const move = (idx: number, dir: -1 | 1) => {
    const next = [...picked];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    setPicked(next);
  };

  const save = (published: boolean) => {
    if (!title.trim()) {
      Alert.alert('请填写课程标题');
      return;
    }
    const course: CourseDto = {
      id: courseId,
      title: title.trim(),
      description: description.trim() || null,
      coachId: me?.id || 'unknown',
      dialect: '多方言',
      published,
      items: [],
      version: existing?.version || 1,
      updatedAt: new Date().toISOString(),
    };
    upsertLocal('courses', course);

    picked.forEach((audioId, orderIndex) => {
      // 已有课目尽量复用 id（保留版本链）
      const old = Object.values(allItems).find(
        (i) => i.courseId === courseId && i.audioId === audioId && !i.deletedAt,
      );
      const item: CourseItemDto = {
        id: old?.id || `cit-${Crypto.randomUUID()}`,
        courseId,
        audioId,
        orderIndex,
        repeatTimes: 3,
        coachTip: tips[audioId] || null,
        version: old?.version || 1,
        updatedAt: new Date().toISOString(),
      };
      upsertLocal('courseItems', item);
    });

    // 被移除的旧课目 → 软删墓碑
    if (existing) {
      for (const old of Object.values(allItems)) {
        if (old.courseId === courseId && !old.deletedAt && !picked.includes(old.audioId)) {
          upsertLocal('courseItems', { ...old, deletedAt: new Date().toISOString() });
        }
      }
    }

    Alert.alert(published ? '已发布到同步队列' : '草稿已保存');
    navigation.goBack();
  };

  return (
    <FlatList
      style={styles.wrap}
      data={assets}
      keyExtractor={(a) => a.id}
      ListHeaderComponent={
        <Card>
          <Text style={styles.h2}>{existing ? '编辑课程' : '新建跟读课'}</Text>
          <TextInput style={styles.input} placeholder="课程标题" value={title} onChangeText={setTitle} />
          <TextInput
            style={[styles.input, { height: 56 }]}
            placeholder="课程说明"
            value={description || ''}
            onChangeText={setDescription}
            multiline
          />
          <Text style={styles.meta}>已选 {picked.length} 句（按选择顺序为课次顺序，可上下移动）</Text>
        </Card>
      }
      renderItem={({ item, index: _index }) => {
        const orderIdx = picked.indexOf(item.id);
        const selected = orderIdx >= 0;
        return (
          <Pressable onPress={() => togglePick(item.id)}>
            <Card style={selected ? styles.pickedCard : undefined}>
              <View style={styles.row}>
                <Text style={{ fontWeight: '700', flex: 1 }}>
                  {selected ? `${orderIdx + 1}. ` : '☐ '}
                  {item.title}
                </Text>
                <Tag text={item.dialect} />
              </View>
              {selected && (
                <View style={{ marginTop: 8 }}>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Button title="↑" small variant="ghost" onPress={() => move(orderIdx, -1)} />
                    <Button title="↓" small variant="ghost" onPress={() => move(orderIdx, 1)} />
                  </View>
                  <TextInput
                    style={styles.input}
                    placeholder="教练提示（发音要点）"
                    value={tips[item.id] || ''}
                    onChangeText={(t) => setTips((m) => ({ ...m, [item.id]: t }))}
                  />
                </View>
              )}
            </Card>
          </Pressable>
        );
      }}
      ListFooterComponent={
        <Card>
          <Button title="保存草稿" variant="ghost" onPress={() => save(false)} />
          <Button title="保存并发布给学员" variant="ok" onPress={() => save(true)} />
        </Card>
      }
    />
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.color.bg },
  h2: { fontWeight: '700', fontSize: 16, marginBottom: 8 },
  input: {
    borderWidth: 1, borderColor: theme.color.border, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 8, marginBottom: 8, backgroundColor: '#fff',
  },
  meta: { color: theme.color.subtext, fontSize: 12 },
  row: { flexDirection: 'row', alignItems: 'center' },
  pickedCard: { borderColor: theme.color.accent, borderWidth: 1.5 },
});
