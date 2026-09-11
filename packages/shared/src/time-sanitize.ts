/**
 * 客户端时间戳清洗。
 *
 * 背景：updatedAt 既参与 LWW 决胜，又曾经直接驱动同步游标。如果信任客户端，
 * 学员可以提交 2999 年的记录：游标被毒化后所有人永远拉不到新数据，
 * 且未来时间的记录在 LWW 中永远胜出。
 *
 * 规则：
 *  - 允许合理的时钟偏移（默认 5 分钟）；
 *  - 超过 now + skew 的未来时间一律钳到 now + skew（不拒绝，避免一条坏记录堵死整个 outbox）；
 *  - 无法解析的值退化为 now；
 *  - 下限：离线编辑可能发生在很久以前，但不接受 1970/1990 这类异常早的时间。
 */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
export const MIN_CLIENT_TIME_MS = Date.UTC(2000, 0, 1);

export function sanitizeClientTime(
  input: string | number | Date | null | undefined,
  now: Date = new Date(),
  skewMs: number = CLOCK_SKEW_MS,
): Date {
  const parsed = input == null ? NaX(input) : new Date(input).getTime();
  let t = Number.isFinite(parsed) ? (parsed as number) : now.getTime();
  const max = now.getTime() + skewMs;
  if (t > max) t = max;
  if (t < MIN_CLIENT_TIME_MS) t = now.getTime();
  return new Date(t);
}

function NaX(_: unknown): number {
  return NaN;
}

/** 便捷：清洗后返回 ISO 字符串 */
export function sanitizeClientIso(
  input: string | number | Date | null | undefined,
  now: Date = new Date(),
  skewMs: number = CLOCK_SKEW_MS,
): string {
  return sanitizeClientTime(input, now, skewMs).toISOString();
}
