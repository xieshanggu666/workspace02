import { describe, expect, it } from 'vitest';
import { sanitizeClientTime, sanitizeClientIso, CLOCK_SKEW_MS } from './time-sanitize';

const NOW = new Date('2026-09-11T12:00:00.000Z');

describe('sanitizeClientTime', () => {
  it('过去的合理时间原样保留（离线编辑需要真实时间参与 LWW）', () => {
    const t = new Date('2026-09-11T08:00:00.000Z');
    expect(sanitizeClientTime(t, NOW).getTime()).toBe(t.getTime());
  });

  it('容差范围内的轻微时钟偏差原样保留', () => {
    const t = new Date(NOW.getTime() + 60_000);
    expect(sanitizeClientTime(t, NOW).getTime()).toBe(t.getTime());
  });

  it('超过容差的未来时间被钳到 now+skew（防止游标毒化）', () => {
    const far = new Date('2999-01-01T00:00:00.000Z');
    const out = sanitizeClientTime(far, NOW);
    expect(out.getTime()).toBe(NOW.getTime() + CLOCK_SKEW_MS);
    expect(out.getTime()).toBeLessThan(NOW.getTime() + 6 * 60_000);
  });

  it('无法解析/空值退化为 now', () => {
    expect(sanitizeClientTime('not-a-date', NOW).getTime()).toBe(NOW.getTime());
    expect(sanitizeClientTime(null, NOW).getTime()).toBe(NOW.getTime());
    expect(sanitizeClientTime(undefined, NOW).getTime()).toBe(NOW.getTime());
  });

  it('异常早的时间（1970/1990）退化为 now', () => {
    expect(sanitizeClientTime(new Date('1970-01-01'), NOW).getTime()).toBe(NOW.getTime());
    expect(sanitizeClientTime(new Date('1990-01-01'), NOW).getTime()).toBe(NOW.getTime());
  });

  it('sanitizeClientIso 返回 ISO 字符串', () => {
    expect(sanitizeClientIso(new Date('2026-09-11T08:00:00Z'), NOW)).toBe('2026-09-11T08:00:00.000Z');
    expect(sanitizeClientIso('2999-01-01', NOW)).toBe(new Date(NOW.getTime() + CLOCK_SKEW_MS).toISOString());
  });
});
