import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { ApiError } from './rules.js';

const ADMIN_TTL_MS = 12 * 60 * 60 * 1000;

export function hashPin(pin: string): string {
  const salt = randomBytes(8).toString('hex');
  return `${salt}:${scryptSync(pin, salt, 32).toString('hex')}`;
}

export function verifyPin(pin: string, stored: string | null): boolean {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const actual = scryptSync(String(pin), salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function safeEqual(a: string, b: string): boolean {
  const x = createHmac('sha256', 'cmp').update(a).digest();
  const y = createHmac('sha256', 'cmp').update(b).digest();
  return timingSafeEqual(x, y);
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export interface AuthEnv {
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
}

export function adminLogin(password: string, env: AuthEnv, now: number): { ok: boolean; token?: string } {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
    throw new ApiError('서버에 관리자 설정(ADMIN_PASSWORD, SESSION_SECRET)이 없습니다.', 500);
  }
  if (!safeEqual(String(password ?? ''), env.ADMIN_PASSWORD)) return { ok: false };
  const payload = Buffer.from(JSON.stringify({ exp: now + ADMIN_TTL_MS })).toString('base64url');
  return { ok: true, token: `${payload}.${sign(payload, env.SESSION_SECRET)}` };
}

export function requireAdmin(token: string, env: AuthEnv, now: number): void {
  if (!env.SESSION_SECRET) throw new ApiError('서버에 SESSION_SECRET이 없습니다.', 500);
  const [payload, sig] = String(token ?? '').split('.');
  if (!payload || !sig || !safeEqual(sig, sign(payload, env.SESSION_SECRET))) {
    throw new ApiError('관리자 인증이 필요합니다.', 401);
  }
  const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp: number };
  if (!(exp > now)) throw new ApiError('관리자 세션이 만료되었습니다. 다시 로그인해 주세요.', 401);
}
