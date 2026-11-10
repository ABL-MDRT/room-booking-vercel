import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from './rules.js';

export const ACCESS_COOKIE = 'wmr_access';
const ACCESS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AccessEnv {
  ACCESS_CODE?: string;
  SESSION_SECRET?: string;
}

const hmac = (value: string, key: string) => createHmac('sha256', key).update(value).digest('base64url');

function same(a: string, b: string): boolean {
  const x = createHmac('sha256', 'cmp').update(a).digest();
  const y = createHmac('sha256', 'cmp').update(b).digest();
  return timingSafeEqual(x, y);
}

function secretOf(env: AccessEnv): string {
  if (!env.SESSION_SECRET) throw new ApiError('서버에 SESSION_SECRET이 없습니다.', 500);
  return env.SESSION_SECRET;
}

/** 접속 코드가 맞으면 서명된 쿠키 값을, 틀리면 null을 돌려준다. */
export function issueAccess(code: string, env: AccessEnv, now: number): string | null {
  if (!env.ACCESS_CODE) throw new ApiError('서버에 ACCESS_CODE가 없습니다.', 500);
  if (!same(String(code ?? ''), env.ACCESS_CODE)) return null;
  const payload = Buffer.from(JSON.stringify({ exp: now + ACCESS_TTL_MS })).toString('base64url');
  return `${payload}.${hmac(payload, secretOf(env))}`;
}

function readCookie(header: string | null | undefined, name: string): string {
  for (const part of String(header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

export function hasAccess(cookieHeader: string | null | undefined, env: AccessEnv, now: number): boolean {
  const [payload, sig] = readCookie(cookieHeader, ACCESS_COOKIE).split('.');
  if (!payload || !sig || !same(sig, hmac(payload, secretOf(env)))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp: number };
    return exp > now;
  } catch {
    return false;
  }
}

export function accessCookie(value: string, secure: boolean): string {
  const maxAge = Math.floor(ACCESS_TTL_MS / 1000);
  return `${ACCESS_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function requireAccess(cookieHeader: string | null | undefined, env: AccessEnv, now: number): void {
  if (!hasAccess(cookieHeader, env, now)) throw new ApiError('접속 코드를 먼저 입력해 주세요.', 401);
}

export function gatePage(): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TF 회의실 예약</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f7fb;color:#152235;font:16px/1.5 "Noto Sans KR",Arial,sans-serif}
.box{box-sizing:border-box;background:#fff;border:1px solid #e4eaf1;border-radius:18px;box-shadow:0 12px 35px rgba(27,63,99,.10);padding:32px;width:min(360px,calc(100% - 32px));text-align:center}
h1{margin:0 0 6px;font-size:22px;color:#0067b9}p{margin:0 0 20px;color:#667085;font-size:14px}
input{width:100%;box-sizing:border-box;border:1px solid #cfd8e3;border-radius:10px;padding:13px;font-size:20px;text-align:center;letter-spacing:.4em}
button{width:100%;margin-top:12px;border:0;border-radius:10px;padding:13px;background:#0067b9;color:#fff;font-size:16px;font-weight:700;cursor:pointer}
.err{color:#d92d20;font-size:14px;min-height:20px;margin-top:10px}</style></head><body>
<form class="box" id="f"><h1>TF 회의실 예약</h1><p>접속 코드를 입력해 주세요.</p>
<input id="c" type="password" inputmode="numeric" autocomplete="off" maxlength="12" autofocus required>
<button type="submit">입장</button><div class="err" id="e"></div></form>
<script>document.getElementById('f').onsubmit=async ev=>{ev.preventDefault();const e=document.getElementById('e');e.textContent='';
try{const r=await fetch('/api/gateLogin',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify([document.getElementById('c').value])});
const b=await r.json().catch(()=>({}));if(r.ok&&b.ok){location.reload();return}e.textContent=b.message||'접속 코드가 올바르지 않습니다.';document.getElementById('c').select()}catch{e.textContent='네트워크 오류입니다. 다시 시도해 주세요.'}}</script></body></html>`;
}
