import { describe, expect, it } from 'vitest';
import { ACCESS_COOKIE, accessCookie, hasAccess, issueAccess, requireAccess } from '../lib/access.js';

const env = { ACCESS_CODE: '9999', SESSION_SECRET: 'secret-test' };
const NOW = Date.parse('2026-11-10T00:00:00Z');
const cookieFor = (value: string) => `${ACCESS_COOKIE}=${value}`;

describe('접속 코드', () => {
  it('틀린 코드는 쿠키를 발급하지 않는다', () => {
    expect(issueAccess('0000', env, NOW)).toBeNull();
    expect(issueAccess('', env, NOW)).toBeNull();
  });

  it('맞는 코드로 받은 쿠키는 접근을 허용한다', () => {
    const v = issueAccess('9999', env, NOW)!;
    expect(hasAccess(`other=1; ${cookieFor(v)}`, env, NOW + 1000)).toBe(true);
  });

  it('쿠키가 없거나 변조되면 접근을 거절한다', () => {
    const v = issueAccess('9999', env, NOW)!;
    expect(hasAccess(undefined, env, NOW)).toBe(false);
    expect(hasAccess(cookieFor(v.slice(0, -2) + 'xx'), env, NOW)).toBe(false);
    expect(hasAccess(cookieFor('abc.def'), env, NOW)).toBe(false);
    expect(() => requireAccess(undefined, env, NOW)).toThrow(/접속 코드/);
  });

  it('다른 비밀키로 서명된 쿠키는 거절한다', () => {
    const v = issueAccess('9999', { ...env, SESSION_SECRET: 'other' }, NOW)!;
    expect(hasAccess(cookieFor(v), env, NOW)).toBe(false);
  });

  it('30일이 지나면 만료된다', () => {
    const v = issueAccess('9999', env, NOW)!;
    expect(hasAccess(cookieFor(v), env, NOW + 31 * 24 * 3600 * 1000)).toBe(false);
  });

  it('ACCESS_CODE가 설정되지 않으면 열어두지 않고 오류를 낸다', () => {
    expect(() => issueAccess('9999', { SESSION_SECRET: 's' }, NOW)).toThrow(/ACCESS_CODE/);
  });

  it('쿠키는 HttpOnly이고 https에서만 Secure가 붙는다', () => {
    expect(accessCookie('v', true)).toMatch(/HttpOnly.*Secure/);
    expect(accessCookie('v', false)).not.toMatch(/Secure/);
  });
});
