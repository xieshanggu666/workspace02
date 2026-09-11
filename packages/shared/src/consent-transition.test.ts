import { describe, expect, it } from 'vitest';
import { consentTransition, isDistributable } from './consent-transition';

describe('isDistributable', () => {
  it('只有 granted + course/public 可分发', () => {
    expect(isDistributable({ consentStatus: 'granted', consentScope: 'course' })).toBe(true);
    expect(isDistributable({ consentStatus: 'granted', consentScope: 'public' })).toBe(true);
    expect(isDistributable({ consentStatus: 'granted', consentScope: 'research' })).toBe(false);
    expect(isDistributable({ consentStatus: 'revoked' })).toBe(false);
    expect(isDistributable({ consentStatus: 'pending' })).toBe(false);
    expect(isDistributable(null)).toBe(false);
  });
});

describe('consentTransition', () => {
  it('course→revoked / course→research 触发 seal', () => {
    expect(consentTransition(
      { consentStatus: 'granted', consentScope: 'course' },
      { consentStatus: 'revoked', consentScope: null },
    )).toBe('seal');
    expect(consentTransition(
      { consentStatus: 'granted', consentScope: 'public' },
      { consentStatus: 'granted', consentScope: 'research' },
    )).toBe('seal');
  });

  it('revoked/research→course/public 触发 restore', () => {
    expect(consentTransition(
      { consentStatus: 'revoked', consentScope: null },
      { consentStatus: 'granted', consentScope: 'course' },
    )).toBe('restore');
    expect(consentTransition(
      { consentStatus: 'granted', consentScope: 'research' },
      { consentStatus: 'granted', consentScope: 'public' },
    )).toBe('restore');
  });

  it('同为可分发或同为不可分发（research↔pending）不动作', () => {
    expect(consentTransition(
      { consentStatus: 'granted', consentScope: 'course' },
      { consentStatus: 'granted', consentScope: 'public' },
    )).toBe('none');
    expect(consentTransition(
      { consentStatus: 'granted', consentScope: 'research' },
      { consentStatus: 'pending', consentScope: null },
    )).toBe('none');
    expect(consentTransition(
      { consentStatus: 'revoked', consentScope: null },
      { consentStatus: 'granted', consentScope: 'research' },
    )).toBe('none');
  });

  it('新建即不可分发（pending/revoked/research）仍 seal，保护先录后授权的素材', () => {
    expect(consentTransition(null, { consentStatus: 'pending' })).toBe('seal');
    expect(consentTransition(null, { consentStatus: 'revoked' })).toBe('seal');
    expect(consentTransition(null, { consentStatus: 'granted', consentScope: 'research' })).toBe('seal');
  });

  it('新建即 course/public 不动作', () => {
    expect(consentTransition(null, { consentStatus: 'granted', consentScope: 'course' })).toBe('none');
  });
});
