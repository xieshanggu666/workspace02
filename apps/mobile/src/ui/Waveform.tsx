import React, { useRef } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { theme } from './theme';
import type { SyllableMark } from '@dialect/shared';

interface Props {
  peaks: number[];
  durationSec: number;
  syllables: SyllableMark[];
  /** 点击波形添加/调整音节边界（标注模式） */
  editable?: boolean;
  onToggleMark?: (sec: number) => void;
  onRemoveMark?: (index: number) => void;
  height?: number;
}

const PX_PER_SEC = 120;
const BAR_WIDTH = 3;
const BAR_GAP = 1;

/**
 * 波形标注条：
 *  - 按录音期采集的 metering 峰值画包络
 *  - 音节区间以半透明色块覆盖，点击空白处在该时间点落一个边界点
 *  - 两个相邻"边界点"形成一个音节；标注 label 在下方列表编辑
 */
export function Waveform({
  peaks, durationSec, syllables, editable, onToggleMark, onRemoveMark, height = 96,
}: Props) {
  const scrollRef = useRef<ScrollView>(null);
  const widthSec = Math.max(durationSec, 1);
  const totalWidth = widthSec * PX_PER_SEC;
  const barsPerSec = peaks.length / widthSec || 10;
  // 抽稀：最多画 totalWidth 根柱
  const step = Math.max(1, Math.floor(peaks.length / (totalWidth / (BAR_WIDTH + BAR_GAP))));

  const bars: number[] = [];
  for (let i = 0; i < peaks.length; i += step) bars.push(peaks[i]);

  const handlePress = (e: { nativeEvent: { locationX: number } }) => {
    if (!editable || !onToggleMark) return;
    const sec = e.nativeEvent.locationX / PX_PER_SEC;
    onToggleMark(Math.max(0, Math.min(durationSec, Number(sec.toFixed(2)))));
  };

  return (
    <View>
      <ScrollView
        ref={scrollRef}
        horizontal
        style={[styles.scroll, { height }]}
        showsHorizontalScrollIndicator
      >
        <Pressable onPress={handlePress} style={{ width: totalWidth, height }}>
          {/* 音节区间 */}
          {syllables.map((s, i) => (
            <View
              key={i}
              style={{
                position: 'absolute',
                left: s.start * PX_PER_SEC,
                width: (s.end - s.start) * PX_PER_SEC,
                top: 0,
                bottom: 0,
                backgroundColor: 'rgba(46,134,222,0.16)',
                borderLeftWidth: 1.5,
                borderLeftColor: theme.color.accent,
                borderRightWidth: 1.5,
                borderRightColor: theme.color.accent,
              }}
            >
              <Text style={styles.sylLabel} numberOfLines={1}>
                {s.label}
              </Text>
            </View>
          ))}
          {/* 峰值柱 */}
          <View style={styles.bars}>
            {bars.map((p, i) => (
              <View
                key={i}
                style={{
                  width: BAR_WIDTH,
                  height: Math.max(2, p * (height - 18)),
                  backgroundColor:
                    editable ? theme.color.primary : p > 0.02 ? theme.color.primary : '#c7d2dd',
                  borderRadius: 1,
                  marginRight: BAR_GAP,
                }}
              />
            ))}
          </View>
          {/* 秒刻度 */}
          {Array.from({ length: Math.ceil(widthSec) + 1 }).map((_, i) => (
            <Text key={i} style={[styles.ruler, { left: i * PX_PER_SEC - 6 }]}>
              {i}s
            </Text>
          ))}
        </Pressable>
      </ScrollView>
      {editable && (
        <Text style={styles.hint}>
          点波形添加音节边界：连续两个边界组成一个音节；已建 {syllables.length} 个音节（当前采样率约{' '}
          {barsPerSec.toFixed(1)} 峰值/秒）
        </Text>
      )}
      {editable && syllables.length > 0 && (
        <View style={{ marginTop: 4 }}>
          {syllables.map((s, i) => (
            <Pressable
              key={i}
              onPress={() => onRemoveMark?.(i)}
              style={styles.removeRow}
            >
              <Text style={{ fontSize: 12, color: theme.color.subtext }}>
                [{s.start.toFixed(2)}–{s.end.toFixed(2)}] {s.label}
                {s.gloss ? `（${s.gloss}）` : ''}
              </Text>
              <Text style={{ color: theme.color.danger, fontSize: 12, fontWeight: '700' }}>删除</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: {
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.color.border,
  },
  bars: { flexDirection: 'row', alignItems: 'flex-end', position: 'absolute', bottom: 14, left: 2 },
  sylLabel: { fontSize: 10, color: theme.color.accent, fontWeight: '700', paddingHorizontal: 2 },
  ruler: { position: 'absolute', bottom: 0, fontSize: 9, color: theme.color.subtext },
  hint: { fontSize: 11, color: theme.color.subtext, marginTop: 4 },
  removeRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingVertical: 3, paddingHorizontal: 4,
  },
});
