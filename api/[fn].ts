import { accessCookie, issueAccess, requireAccess } from '../lib/access.js';
import { vercelCache } from '../lib/cache.js';
import { connectNeon } from '../lib/db.js';
import { CACHE_TAGS, handlers, toArgs, WRITE_FUNCTIONS, type Ctx } from '../lib/handlers.js';
import { ApiError } from '../lib/rules.js';

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return json({ message: 'POST만 지원합니다.' }, 405);

    const fn = decodeURIComponent(new URL(request.url).pathname.split('/').filter(Boolean).at(-1) ?? '');
    const secure = new URL(request.url).protocol === 'https:';
    if (fn === 'gateLogin') {
      try {
        const [code] = toArgs(fn, await request.json().catch(() => []));
        const cookie = issueAccess(String(code ?? ''), process.env, Date.now());
        if (!cookie) {
          await new Promise((r) => setTimeout(r, 500)); // 코드 대입 공격 속도를 늦춘다
          return json({ ok: false, message: '접속 코드가 올바르지 않습니다.' }, 401);
        }
        return Response.json({ ok: true }, { headers: { 'Set-Cookie': accessCookie(cookie, secure), 'Cache-Control': 'no-store' } });
      } catch (err) {
        if (err instanceof ApiError) return json({ message: err.message }, err.status);
        throw err;
      }
    }
    const handler = Object.hasOwn(handlers, fn) ? handlers[fn] : undefined;
    if (!handler) return json({ message: `알 수 없는 API입니다: ${fn}` }, 404);

    try {
      requireAccess(request.headers.get('cookie'), process.env, Date.now());
    } catch (err) {
      if (err instanceof ApiError) return json({ message: err.message }, err.status);
      throw err;
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return json({ message: '요청 본문이 JSON이 아닙니다.' }, 400);
    }
    const args = toArgs(fn, payload);

    const cache = vercelCache();
    const ctx: Ctx = { db: connectNeon(), env: process.env, now: Date.now(), cache };
    try {
      const result = await handler(ctx, ...args);
      if (WRITE_FUNCTIONS.has(fn) && (result as { ok?: boolean })?.ok !== false) await cache.expire(CACHE_TAGS);
      return json(result, (result as { ok?: boolean })?.ok === false && fn.includes('eservation') ? 409 : 200);
    } catch (err) {
      if (err instanceof ApiError) return json({ message: err.message }, err.status);
      console.error(`API ${fn} 처리 중 오류:`, err);
      return json({ message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' }, 500);
    }
  },
};
