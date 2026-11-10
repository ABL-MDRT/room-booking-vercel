import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { handlers, toArgs, type Ctx } from '../lib/handlers.js';
import { accessCookie, gatePage, hasAccess, issueAccess, requireAccess } from '../lib/access.js';
import { noCache } from '../lib/cache.js';
import { ApiError } from '../lib/rules.js';
import { applySchema, openDb } from './local-db.js';

const port = Number(process.env.PORT ?? 3100);
const { db, target } = await openDb();
await applySchema(db);
const env = { ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? 'dev-admin', SESSION_SECRET: 'dev-secret', ACCESS_CODE: process.env.ACCESS_CODE ?? '9999' };
const page = await readFile(new URL('../views/index.html', import.meta.url));

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const fn = /^\/api\/(\w+)$/.exec(url.pathname)?.[1];
  const cookie = req.headers.cookie;
  if (!fn) {
    const ok = hasAccess(cookie, env, Date.now());
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'text/html; charset=utf-8' }).end(ok ? page : gatePage());
    return;
  }

  const send = (status: number, body: unknown) =>
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  if (fn === 'gateLogin') {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const [code] = JSON.parse(Buffer.concat(chunks).toString() || '[]');
    const value = issueAccess(String(code ?? ''), env, Date.now());
    if (!value) return send(401, { ok: false, message: '접속 코드가 올바르지 않습니다.' });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': accessCookie(value, false) }).end('{"ok":true}');
    return;
  }
  const handler = Object.hasOwn(handlers, fn) ? handlers[fn] : undefined;
  if (!handler) return send(404, { message: `알 수 없는 API입니다: ${fn}` });

  try { requireAccess(cookie, env, Date.now()); } catch (err) {
    return send((err as ApiError).status ?? 401, { message: (err as Error).message });
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const payload = JSON.parse(Buffer.concat(chunks).toString() || '[]');
  const args = toArgs(fn, payload);
  const ctx: Ctx = { db, env, now: Date.now(), cache: noCache };
  try {
    const result = await handler(ctx, ...args);
    send((result as { ok?: boolean })?.ok === false && fn.includes('eservation') ? 409 : 200, result);
  } catch (err) {
    if (err instanceof ApiError) return send(err.status, { message: err.message });
    console.error(fn, err);
    send(500, { message: '서버 오류가 발생했습니다.' });
  }
}).listen(port, () => console.log(`개발 서버 http://localhost:${port}  (DB: ${target})`));
