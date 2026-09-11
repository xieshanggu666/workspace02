import React from 'react';
import { View, Text, FlatList, Pressable } from 'react-native';
import { useStore } from '../store';
import { theme } from '../ui/theme';
import { Card, Tag, Button } from '../ui/bits';

export function LibraryScreen({ navigation }: any) {
  const me = useStore((s) => s.me);
  const assets = useStore((s) =>
    Object.values(s.audio)
      .filter((a) => !a.deletedAt)
      .filter((a) => (me?.role === 'student' ? a.status !== 'restricted' : true)),
  );
  const speakers = useStore((s) => s.speakers);

  return (
    <FlatList
      style={{ backgroundColor: theme.color.bg }}
      data={[...assets].sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1))}
      keyExtractor={(a) => a.id}
      ListHeaderComponent={
        <View style={{ padding: 12 }}>
          <Text style={{ color: theme.color.subtext }}>
            共 {assets.length} 条素材；点条目进入波形标注。
          </Text>
        </View>
      }
      renderItem={({ item }) => {
        const spk = speakers[item.speakerId];
        return (
          <Pressable onPress={() => navigation.navigate('AssetEditor', { id: item.id })}>
            <Card>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontWeight: '700', flex: 1 }}>
                  {item.status === 'restricted' ? '🔒 ' : '🎙 '}
                  {item.title}
                </Text>
                <Tag
                  text={item.status}
                  tone={item.status === 'published' ? 'ok' : item.status === 'restricted' ? 'danger' : 'default'}
                />
              </View>
              <Text style={{ color: theme.color.subtext, fontSize: 12, marginTop: 4 }}>
                {item.dialect} · {spk?.name || item.speakerId} · {item.durationSec.toFixed(1)}s
                {item.syllables.length ? ` · ${item.syllables.length} 音节已切分` : ' · 未标注'}
                {item.transcript ? ` · ${item.transcript}` : ''}
              </Text>
            </Card>
          </Pressable>
        );
      }}
    />
  );
}

/** 教练/学员共用：课程列表 */
export function CoursesScreen({ navigation }: any) {
  const me = useStore((s) => s.me);
  const courses = useStore((s) =>
    Object.values(s.courses)
      .filter((c) => !c.deletedAt)
      .filter((c) => (me?.role === 'student' ? c.published : true)),
  );
  const items = useStore((s) => s.courseItems);
  const assets = useStore((s) => s.audio);

  return (
    <FlatList
      style={{ backgroundColor: theme.color.bg }}
      data={courses.sort((a, b) => (a.title > b.title ? 1 : -1))}
      keyExtractor={(c) => c.id}
      ListHeaderComponent={
        me?.role === 'coach' || me?.role === 'admin' ? (
          <View style={{ padding: 12 }}>
            <Button title="+ 编排新课程" small variant="ghost" onPress={() => navigation.navigate('CourseEditor', { id: undefined })} />
          </View>
        ) : null
      }
      renderItem={({ item: course }) => {
        const count = Object.values(items).filter((i) => i.courseId === course.id && !i.deletedAt).length;
        return (
          <Pressable onPress={() => navigation.navigate('CourseDetail', { id: course.id })}>
            <Card>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontWeight: '700', fontSize: 15 }}>{course.title}</Text>
                <Tag text={course.published ? '已发布' : '草稿'} tone={course.published ? 'ok' : 'default'} />
              </View>
              <Text style={{ color: theme.color.subtext, fontSize: 12, marginTop: 4 }}>
                {course.dialect} · {count} 课次
              </Text>
              {course.description ? (
                <Text style={{ color: theme.color.subtext, fontSize: 12, marginTop: 4 }}>{course.description}</Text>
              ) : null}
            </Card>
          </Pressable>
        );
      }}
    />
  );
}
