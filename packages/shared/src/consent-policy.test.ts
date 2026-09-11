import { describe, expect, it } from 'vitest';
import { canAccessMedia, canUseInCourse, mediaDenyReason } from './consent-policy';

const granted = (scope: 'research' | 'course' | 'public') => ({
  consentStatus: 'granted' as const,
  consentScope: scope,
});

describe('canAccessMedia —— 知情同意范围闸门', () => {
  it('research 仅调查员/管理员可取，教练与学员均被拒绝', () => {
    expect(canAccessMedia(granted('research'), 'investigator')).toBe(true);
    expect(canAccessMedia(granted('research'), 'admin')).toBe(true);
    expect(canAccessMedia(granted('research'), 'coach')).toBe(false);
    expect(canAccessMedia(granted('research'), 'student')).toBe(false);
  });

  it('course / public 对教练与学员开放', () => {
    for (const scope of ['course', 'public'] as const) {
      expect(canAccessMedia(granted(scope), 'coach')).toBe(true);
      expect(canAccessMedia(granted(scope), 'student')).toBe(true);
    }
  });

  it('pending / revoked / 无授权 只允许 staff', () => {
    expect(canAccessMedia({ consentStatus: 'pending' }, 'student')).toBe(false);
    expect(canAccessMedia({ consentStatus: 'pending' }, 'coach')).toBe(false);
    expect(canAccessMedia({ consentStatus: 'revoked' }, 'coach')).toBe(false);
    expect(canAccessMedia({ consentStatus: 'revoked' }, 'student')).toBe(false);
    expect(canAccessMedia({ consentStatus: 'revoked' }, 'investigator')).toBe(true);
  });

  it('已 course 授权但标记 sensitive（重新授权后保留加密落盘）：分发照常放行', () => {
    // 分发只看授权；sensitive 仅表示是否加密落盘，下载时内存解密
    expect(canAccessMedia({ ...granted('course'), sensitive: true }, 'student')).toBe(true);
    expect(canAccessMedia({ ...granted('course'), sensitive: true }, 'coach')).toBe(true);
  });

  it('pending/revoked 即使带敏感标记也只 staff 可取', () => {
    expect(canAccessMedia({ consentStatus: 'pending', sensitive: false }, 'student')).toBe(false);
    expect(canAccessMedia({ consentStatus: 'pending', sensitive: true }, 'student')).toBe(false);
  });
});

describe('canUseInCourse —— 编入跟读课', () => {
  it('research 不能进课程（任何非 staff 角色）', () => {
    expect(canUseInCourse(granted('research'), 'coach')).toBe(false);
  });
  it('course/public 可进课程；pending/revoked 不可', () => {
    expect(canUseInCourse(granted('course'))).toBe(true);
    expect(canUseInCourse(granted('public'))).toBe(true);
    expect(canUseInCourse({ consentStatus: 'pending' })).toBe(false);
    expect(canUseInCourse({ consentStatus: 'revoked' })).toBe(false);
  });
});

describe('mediaDenyReason', () => {
  it('research 给出明确的用途超范围提示', () => {
    expect(mediaDenyReason(granted('research'), 'student')).toContain('仅限学术研究');
  });
});
