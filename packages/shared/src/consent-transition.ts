import type { ConsentScope, ConsentStatus } from './types';

export interface ConsentState {
  consentStatus?: ConsentStatus | null;
  consentScope?: ConsentScope | null;
}

/** 该授权状态下的素材是否允许课程/公开级分发（学员/教练可访问） */
export function isDistributable(s: ConsentState | null | undefined): boolean {
  return (
    !!s &&
    s.consentStatus === 'granted' &&
    (s.consentScope === 'course' || s.consentScope === 'public')
  );
}

export type ConsentAction = 'none' | 'seal' | 'restore';

/**
 * 授权状态迁移后的收口动作（纯函数，供 REST 与同步通道共用）：
 *
 *  - 迁移到「不可分发」（granted+research、pending、revoked、无授权）→ seal：
 *    必须把名下明文录音加密封口；
 *  - 迁移到「可分发」（granted+course/public，且之前不可分发）→ restore：
 *    元数据恢复可分发（文件可保留加密）；
 *  - 同为可分发或同为不可分发 → none（research↔pending 之间不需要动文件）。
 *
 * 新建（before 为 null）时：
 *  - 若建立即不可分发（例如现场录入 pending/revoked/research 授权），也要 seal，
 *    确保已存在的素材（通常是先录音后补授权）被收口。
 */
export function consentTransition(before: ConsentState | null | undefined, after: ConsentState): ConsentAction {
  const isNew = !before;
  const beforeDistributable = isDistributable(before ?? null);
  const afterDistributable = isDistributable(after);

  if (beforeDistributable && !afterDistributable) return 'seal';
  // 新建即可分发时没有需要恢复的旧资产
  if (!isNew && !beforeDistributable && afterDistributable) return 'restore';

  // 新建说话人且初始即不可分发：若名下已有素材则应封口（先录音后补授权场景）
  if (isNew && !afterDistributable) return 'seal';
  return 'none';
}
