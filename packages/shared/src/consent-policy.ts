import type { ConsentScope, ConsentStatus } from './types';

export type AppRole = 'investigator' | 'speaker' | 'coach' | 'student' | 'admin';

/**
 * 知情同意使用范围的统一判定（端、服务端、同步引擎共用，避免各处各写一套）。
 *
 * consentStatus：granted / pending / revoked
 * consentScope ：research（仅学术研究）/ course（跟读课程）/ public（公开示范）
 *
 * 分发决策只看授权状态与范围；素材是否加密落盘（sensitive/keyVersion）是另一回事
 * —— 撤回封口后即使重新获得 course/public 授权，文件可继续加密存储但分发恢复。
 *
 *  - research：只供调查员、管理员做研究/归档；教练与学员都不可取，更不能进课程
 *  - course  ：调查员/管理员 + 教练（可编课）+ 学员（可练习）
 *  - public  ：同 course，且语义上允许更广泛公开
 *  - pending / revoked / 无记录：仅调查员/管理员
 */
export function canAccessMedia(
  ctx: {
    consentStatus?: ConsentStatus | null;
    consentScope?: ConsentScope | null;
    /** 仅表示是否加密落盘，不参与分发授权判定 */
    sensitive?: boolean;
  },
  role: AppRole,
): boolean {
  const staff = role === 'investigator' || role === 'admin';
  if (staff) return true;

  const { consentStatus, consentScope } = ctx;

  if (consentStatus === 'revoked') return false;
  if (consentStatus !== 'granted') return false; // pending 或未知
  if (consentScope === 'research') return false; // 仅限研究：教练/学员均不可
  if (consentScope === 'course' || consentScope === 'public') return true;
  return false;
}

/** 学员练习/下载：只接受已授予且范围至少是课程级 */
export function canStudentPlay(
  ctx: { consentStatus?: ConsentStatus | null; consentScope?: ConsentScope | null },
): boolean {
  return canAccessMedia(ctx, 'student');
}

/** 教练能否把素材编入跟读课：必须课程级或公开；research 不允许 */
export function canUseInCourse(
  ctx: { consentStatus?: ConsentStatus | null; consentScope?: ConsentScope | null },
  role: AppRole = 'coach',
): boolean {
  if (role === 'investigator' || role === 'admin') return true;
  const { consentStatus, consentScope } = ctx;
  if (consentStatus !== 'granted') return false;
  return consentScope === 'course' || consentScope === 'public';
}

/** 人类可读的拒绝原因（用于日志与错误提示） */
export function mediaDenyReason(
  ctx: { consentStatus?: ConsentStatus | null; consentScope?: ConsentScope | null; sensitive?: boolean },
  role: AppRole,
): string {
  const staff = role === 'investigator' || role === 'admin';
  if (staff) return '';
  if (ctx.consentStatus === 'revoked') return '该说话人已撤回授权，素材禁止分发';
  if (ctx.sensitive || ctx.consentStatus === 'pending' || !ctx.consentStatus) {
    return '受限录音：授权未完成，需调查员/管理员权限';
  }
  if (ctx.consentScope === 'research') {
    return '该录音仅限学术研究用途，不能用于课程或学员练习';
  }
  return '无权访问该录音';
}
