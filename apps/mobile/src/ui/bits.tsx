import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { theme } from './theme';

export function Card({ children, style }: { children: React.ReactNode; style?: any }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Tag({ text, tone = 'default' }: { text: string; tone?: 'default' | 'warn' | 'danger' | 'ok' | 'accent' }) {
  const bg = {
    default: '#eef1f5',
    warn: '#fdf0e3',
    danger: '#fbe9e7',
    ok: '#e8f8f0',
    accent: '#e8f1fc',
  }[tone];
  const fg = {
    default: theme.color.subtext,
    warn: theme.color.warn,
    danger: theme.color.danger,
    ok: theme.color.ok,
    accent: theme.color.accent,
  }[tone];
  return (
    <View style={[styles.tag, { backgroundColor: bg }]}>
      <Text style={[styles.tagText, { color: fg }]}>{text}</Text>
    </View>
  );
}

export function Button({
  title, onPress, variant = 'primary', disabled, small,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'ghost' | 'danger' | 'ok';
  disabled?: boolean;
  small?: boolean;
}) {
  const bg = {
    primary: theme.color.primary,
    ghost: 'transparent',
    danger: theme.color.danger,
    ok: theme.color.ok,
  }[variant];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        small && styles.btnSmall,
        { backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 },
        variant === 'ghost' && styles.btnGhost,
      ]}
    >
      <Text style={[styles.btnText, variant === 'ghost' && { color: theme.color.primary }]}>{title}</Text>
    </Pressable>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.color.card,
    borderRadius: theme.radius,
    padding: 14,
    marginHorizontal: 12,
    marginVertical: 6,
    borderWidth: 1,
    borderColor: theme.color.border,
  },
  tag: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start', marginRight: 6 },
  tagText: { fontSize: 12, fontWeight: '600' },
  btn: {
    borderRadius: 8, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center',
    marginVertical: 4,
  },
  btnSmall: { paddingVertical: 7, paddingHorizontal: 12, marginVertical: 2 },
  btnGhost: { borderWidth: 1, borderColor: theme.color.primary },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  label: { fontSize: 12, color: theme.color.subtext, marginBottom: 4, fontWeight: '600' },
});
