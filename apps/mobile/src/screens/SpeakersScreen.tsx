import React, { useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, TextInput } from 'react-native';
import { useStore } from '../store';
import { theme } from '../ui/theme';
import { Button, Card, Tag } from '../ui/bits';
import type { SpeakerDto, ConsentScope } from '@dialect/shared';

const AGREEMENT = `《方言录音知情同意书（示范文本）》
1. 我同意调查员对我的方言发音进行录音/录像；
2. 录音用于（按勾选范围）：学术研究 / 跟读课程制作 / 公开示范；
3. 我有权随时撤回授权，撤回后素材将被封口加密、停止分发；
4. 调查方将对我的个人信息与敏感录音加密保存。`;

export function SpeakersScreen({ navigation }: any) {
  const speakers = useStore((s) => Object.values(s.speakers).filter((x) => !x.deletedAt));
  const me = useStore((s) => s.me);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [dialect, setDialect] = useState('');
  const [region, setRegion] = useState('');
  const upsertLocal = useStore((s) => s.upsertLocal);

  const canEdit = me?.role === 'investigator' || me?.role === 'admin';

  const createSpeaker = () => {
    if (!name.trim() || !dialect.trim()) return;
    const id = `spk-${Math.random().toString(36).slice(2, 10)}`;
    const dto: SpeakerDto = {
      id, code: `FIELD-${id.slice(-6).toUpperCase()}`, name: name.trim(),
      dialect: dialect.trim(), region: region.trim() || '（待补充）',
      consentStatus: 'pending', consentScope: null, consentHash: null,
      version: 1, updatedAt: new Date().toISOString(),
    };
    upsertLocal('speakers', dto);
    setName(''); setDialect(''); setRegion(''); setCreating(false);
    navigation.navigate('SpeakerDetail', { id });
  };

  return (
    <View style={styles.wrap}>
      <FlatList
        data={[...speakers].sort((a, b) => (a.name > b.name ? 1 : -1))}
        keyExtractor={(s) => s.id}
        ListHeaderComponent={
          canEdit ? (
            <Card>
              {!creating ? (
                <Button title="+ 新建说话人档案" small variant="ghost" onPress={() => setCreating(true)} />
              ) : (
                <View>
                  <TextInput style={styles.input} placeholder="姓名/化名" value={name} onChangeText={setName} />
                  <TextInput style={styles.input} placeholder="方言，如 吴语-苏州话" value={dialect} onChangeText={setDialect} />
                  <TextInput style={styles.input} placeholder="地区，如 江苏省苏州市" value={region} onChangeText={setRegion} />
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Button title="保存（待授权）" small onPress={createSpeaker} />
                    <Button title="取消" small variant="ghost" onPress={() => setCreating(false)} />
                  </View>
                </View>
              )}
            </Card>
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable onPress={() => navigation.navigate('SpeakerDetail', { id: item.id })}>
            <Card>
              <View style={styles.row}>
                <Text style={styles.name}>{item.name}</Text>
                <ConsentTag status={item.consentStatus} />
              </View>
              <Text style={styles.meta}>
                {item.code} · {item.dialect} · {item.region}
              </Text>
              {item.notes ? <Text style={styles.notes}>{item.notes}</Text> : null}
            </Card>
          </Pressable>
        )}
      />
    </View>
  );
}

export function ConsentTag({ status }: { status: SpeakerDto['consentStatus'] }) {
  if (status === 'granted') return <Tag tone="ok" text="已授权" />;
  if (status === 'revoked') return <Tag tone="danger" text="已撤回" />;
  return <Tag tone="warn" text="待签署" />;
}

export function SpeakerDetailScreen({ route, navigation }: any) {
  const { id } = route.params as { id: string };
  const speaker = useStore((s) => s.speakers[id]);
  const audio = useStore((s) => Object.values(s.audio).filter((a) => a.speakerId === id && !a.deletedAt));
  const upsertLocal = useStore((s) => s.upsertLocal);
  const me = useStore((s) => s.me);
  const [scope, setScope] = useState<ConsentScope>('research');

  if (!speaker) return <View style={styles.wrap}><Text>档案不存在</Text></View>;
  const canEdit = me?.role === 'investigator' || me?.role === 'admin';

  const grant = () => {
    const hash = `sha256:${simpleHash(`${AGREEMENT}||${speaker.code}||${scope}`)}`;
    upsertLocal('speakers', {
      ...speaker,
      consentStatus: 'granted',
      consentScope: scope,
      consentHash: hash,
      consentSignedAt: new Date().toISOString(),
    });
  };

  const revoke = () => {
    // 本地也立即把名下音频封口
    for (const a of audio) {
      if (a.status !== 'restricted') {
        upsertLocal('audio', { ...a, status: 'restricted', sensitive: true, keyVersion: a.keyVersion ?? 1 });
      }
    }
    upsertLocal('speakers', { ...speaker, consentStatus: 'revoked', consentScope: null });
  };

  return (
    <View style={styles.wrap}>
      <Card>
        <View style={styles.row}>
          <Text style={styles.name}>{speaker.name}</Text>
          <ConsentTag status={speaker.consentStatus} />
        </View>
        <Text style={styles.meta}>{speaker.dialect} · {speaker.region}</Text>
        {speaker.consentHash ? <Text style={styles.notes}>授权哈希：{speaker.consentHash}</Text> : null}
      </Card>

      {canEdit && speaker.consentStatus !== 'granted' && (
        <Card>
          <Text style={styles.sectionTitle}>电子授权</Text>
          <Text style={styles.agreement}>{AGREEMENT}</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginVertical: 8 }}>
            {(['research', 'course', 'public'] as ConsentScope[]).map((s) => (
              <Pressable key={s} onPress={() => setScope(s)}>
                <Tag
                  text={s === 'research' ? '学术研究' : s === 'course' ? '跟读课程' : '公开示范'}
                  tone={scope === s ? 'accent' : 'default'}
                />
              </Pressable>
            ))}
          </View>
          <Button title="发音人已阅读并同意 —— 签署" small variant="ok" onPress={grant} />
        </Card>
      )}

      {canEdit && speaker.consentStatus === 'granted' && (
        <Card>
          <Text style={{ marginBottom: 8 }}>已授权范围：<Text style={{ fontWeight: '700' }}>
            {speaker.consentScope === 'research' ? '学术研究' : speaker.consentScope === 'course' ? '跟读课程' : '公开示范'}
          </Text></Text>
          <Button title="撤回授权（名下录音立即封口加密）" small variant="danger" onPress={revoke} />
        </Card>
      )}

      <Card>
        <View style={styles.row}>
          <Text style={styles.sectionTitle}>名下素材（{audio.length}）</Text>
          {canEdit && speaker.consentStatus !== 'revoked' && (
            <Button title="+ 录音采集" small onPress={() => navigation.navigate('Recorder', { speakerId: id })} />
          )}
        </View>
        {audio.map((a) => (
          <Pressable key={a.id} onPress={() => navigation.navigate('AssetEditor', { id: a.id })}>
            <Text style={styles.audioLine}>
              {a.status === 'restricted' ? '🔒 ' : '🎙 '}
              {a.title || '（未命名录音）'} · {a.durationSec.toFixed(1)}s
            </Text>
          </Pressable>
        ))}
      </Card>
    </View>
  );
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  // 演示用本地非加密摘要；服务端签署时会重新计算真正的 sha256
  return Math.abs(h).toString(16).padStart(8, '0');
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.color.bg, paddingTop: 8 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  name: { fontSize: 16, fontWeight: '700', color: theme.color.text },
  meta: { color: theme.color.subtext, fontSize: 13, marginTop: 2 },
  notes: { color: theme.color.subtext, fontSize: 11, marginTop: 6 },
  input: {
    borderWidth: 1, borderColor: theme.color.border, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 8, marginBottom: 8, backgroundColor: '#fff',
  },
  sectionTitle: { fontWeight: '700', color: theme.color.text, marginBottom: 6 },
  agreement: { fontSize: 11, color: theme.color.subtext, lineHeight: 16, marginBottom: 6 },
  audioLine: { paddingVertical: 6, fontSize: 14, color: theme.color.primary },
});
