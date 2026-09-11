import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, Alert } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { syncNow, resolveConflict } from '../sync';
import { useStore } from '../store';
import { setToken } from '../api';
import { getApiBase, setApiBase } from '../config';
import { theme } from '../ui/theme';
import { Button, Card, Tag } from '../ui/bits';

export function SyncScreen() {
  const me = useStore((s) => s.me);
  const outbox = useStore((s) => s.outbox);
  const conflicts = useStore((s) => s.conflicts);
  const lastSyncAt = useStore((s) => s.lastSyncAt);
  const syncState = useStore((s) => s.syncState);
  const syncMessage = useStore((s) => s.syncMessage);
  const reset = useStore((s) => s.reset);
  const [apiBase, setApiBaseState] = useState('');
  const qc = useQueryClient();

  React.useEffect(() => {
    getApiBase().then(setApiBaseState);
  }, []);

  const doSync = async () => {
    try {
      const r = await syncNow();
      qc.invalidateQueries();
      Alert.alert('同步完成', `推送 ${r.pushed} 条，拉取 ${r.pulled} 条，冲突 ${r.conflicts} 条。`);
    } catch (e: any) {
      Alert.alert('同步失败', e?.message || String(e));
    }
  };

  const logout = async () => {
    await setToken(null);
    reset();
    qc.clear();
  };

  const counts = outbox.reduce<Record<string, number>>((acc, o) => {
    acc[o.bucket] = (acc[o.bucket] || 0) + 1;
    return acc;
  }, {});

  return (
    <ScrollView style={styles.wrap}>
      <Card>
        <Text style={styles.h2}>账号</Text>
        <Text>{me?.displayName}（{me?.role}）</Text>
        <Button title="退出登录" small variant="ghost" onPress={logout} />
      </Card>

      <Card>
        <Text style={styles.h2}>同步状态</Text>
        <View style={styles.row}>
          <Tag text={syncState === 'idle' ? '空闲' : syncState} tone={syncState === 'idle' ? 'ok' : 'accent'} />
          <Text style={styles.meta}>
            上次同步：{lastSyncAt ? new Date(lastSyncAt).toLocaleString() : '从未'}
          </Text>
        </View>
        {syncMessage && <Text style={styles.meta}>{syncMessage}</Text>}

        <Text style={{ marginTop: 10, fontWeight: '700' }}>待推送队列（离线变更）</Text>
        {outbox.length === 0 ? (
          <Text style={styles.meta}>队列为空 —— 本地全部变更都已与服务器一致。</Text>
        ) : (
          <Text style={styles.meta}>
            {Object.entries(counts).map(([k, v]) => `${bucketLabel(k)} ${v} 条`).join('，')}
            {'\n'}其中 {outbox.filter((o) => o.localFileUri).length} 条带本地录音待补传
          </Text>
        )}
        <Button title={outbox.length ? "立即同步（推送 → 上传媒体 → 拉取）" : '拉取远端更新'} onPress={doSync} />
      </Card>

      {conflicts.length > 0 && (
        <Card>
          <Text style={[styles.h2, { color: theme.color.danger }]}>版本冲突（{conflicts.length}）</Text>
          {conflicts.map((c, i) => (
            <View key={`${c.id}-${i}`} style={styles.conflict}>
              <Text style={{ fontWeight: '700' }}>
                {bucketLabel(c.entityType)} / {c.id}
              </Text>
              <Text style={styles.meta}>
                原因：{c.reason === 'deleted' ? '服务端已删除（拒绝复活）' : '两端都修改了同一版本'}
                {'\n'}服务端：{summarize(c.server)}
                {'\n'}本机：{summarize(c.client)}
              </Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button
                  title="采用服务端版本"
                  small
                  variant="ghost"
                  onPress={async () => {
                    await resolveConflict(c, 'server');
                    Alert.alert('已采用服务端版本');
                  }}
                />
                <Button
                  title="强制保留本机版本"
                  small
                  variant="danger"
                  onPress={async () => {
                    try {
                      await resolveConflict(c, 'client');
                      Alert.alert('本机版本已覆盖到服务器');
                    } catch (e: any) {
                      Alert.alert('失败', e.message);
                    }
                  }}
                />
              </View>
            </View>
          ))}
        </Card>
      )}

      <Card>
        <Text style={styles.h2}>服务器地址</Text>
        <Text style={styles.meta}>
          模拟器用 127.0.0.1；真机请填电脑局域网 IP，如 http://192.168.1.10:3000/api
        </Text>
        <TextInput
          style={styles.input}
          value={apiBase}
          onChangeText={setApiBaseState}
          autoCapitalize="none"
          placeholder="http://127.0.0.1:3000/api"
        />
        <Button
          title="保存地址"
          small
          variant="ghost"
          onPress={async () => {
            if (apiBase) {
              await setApiBase(apiBase);
              Alert.alert('已保存');
            }
          }}
        />
      </Card>

      <Text style={styles.securityNote}>
        安全说明：敏感录音在本机为 AES-256 加密文件（主密钥存 Keychain/Keystore），
        服务端对受限素材再次 AES-256-GCM 加密落盘；撤回授权后两端自动封口。
      </Text>
    </ScrollView>
  );
}

function bucketLabel(b: string) {
  return ({
    speakers: '说话人', audio: '音频', courses: '课程',
    courseItems: '课目', attempts: '跟读', annotations: '批注',
    users: '用户',
  } as Record<string, string>)[b] || b;
}

function summarize(e: any) {
  if (!e) return '（不存在/已删除）';
  return e.name || e.title || e.comment || `v${e.version ?? '?'}`;
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.color.bg },
  h2: { fontWeight: '700', fontSize: 15, marginBottom: 6 },
  meta: { color: theme.color.subtext, fontSize: 12, marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    borderWidth: 1, borderColor: theme.color.border, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 8, marginVertical: 6, backgroundColor: '#fff',
  },
  conflict: { borderTopWidth: 1, borderTopColor: theme.color.border, paddingVertical: 8 },
  securityNote: {
    color: theme.color.subtext, fontSize: 11, textAlign: 'center',
    marginHorizontal: 24, marginVertical: 16,
  },
});
