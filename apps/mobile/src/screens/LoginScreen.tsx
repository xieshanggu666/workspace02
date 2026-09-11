import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet, KeyboardAvoidingView, Platform, Alert } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { api, setToken, ApiError } from '../api';
import { getDeviceId } from '../config';
import { useStore } from '../store';
import { theme } from '../ui/theme';
import { Button, Card, Field } from '../ui/bits';

export function LoginScreen() {
  const [username, setUsername] = useState('investigator1');
  const [password, setPassword] = useState('demo1234');
  const [busy, setBusy] = useState(false);
  const setMe = useStore((s) => s.setMe);
  const qc = useQueryClient();

  const login = async () => {
    setBusy(true);
    try {
      const deviceId = await getDeviceId();
      const res = await api.login(username.trim(), password, deviceId);
      await setToken(res.token);
      setMe(res.user);
      qc.invalidateQueries();
    } catch (e) {
      Alert.alert('登录失败', e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.wrap}>
      <Text style={styles.title}>方言田野工作站</Text>
      <Text style={styles.subtitle}>录音 · 授权 · 标注 · 跟读课（离线可用）</Text>
      <Card>
        <Field label="用户名">
          <TextInput
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            style={styles.input}
            placeholder="investigator1 / coach1 / student1 / admin"
          />
        </Field>
        <Field label="密码">
          <TextInput
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            style={styles.input}
            placeholder="demo1234"
          />
        </Field>
        <Button title={busy ? '登录中…' : '登录'} onPress={login} disabled={busy} />
      </Card>
      <Text style={styles.note}>
        演示账号密码均为 demo1234。首次登录后可完全离线采集，联网后在“同步”页合并。
      </Text>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.color.bg, justifyContent: 'center', paddingTop: 60 },
  title: { fontSize: 26, fontWeight: '800', color: theme.color.primary, textAlign: 'center' },
  subtitle: { fontSize: 13, color: theme.color.subtext, textAlign: 'center', marginBottom: 18, marginTop: 4 },
  input: {
    borderWidth: 1, borderColor: theme.color.border, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, backgroundColor: '#fff',
  },
  note: { fontSize: 12, color: theme.color.subtext, textAlign: 'center', marginHorizontal: 32, marginTop: 14 },
});
