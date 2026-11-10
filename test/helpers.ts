import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import type { Db } from '../lib/db.js';
import type { Ctx } from '../lib/handlers.js';

export const ROOMS = [
  ['room-2-north', '2층 1회의실', 2, '북쪽', 10, '#0067b9', 1],
  ['room-2-south', '2층 2회의실', 2, '남쪽', 10, '#00a5df', 2],
  ['room-14-east', '14층 1회의실', 14, '북쪽', 16, '#f97316', 5],
  ['room-14-west', '14층 2회의실', 14, '남쪽', 16, '#d946ef', 6],
  ['room-15-a', '15층 1회의실', 15, '북쪽', 10, '#14b8a6', 7],
] as const;

export async function makeCtx(now = Date.parse('2026-11-10T01:00:00Z')): Promise<Ctx & { raw: PGlite }> {
  const raw = new PGlite({ extensions: { btree_gist } });
  await raw.exec(readFileSync(new URL('../lib/schema.sql', import.meta.url), 'utf8'));
  for (const r of ROOMS) {
    await raw.query('INSERT INTO rooms VALUES ($1,$2,$3,$4,$5,$6,$7)', [...r]);
  }
  const db: Db = { query: async (sql, params) => (await raw.query(sql, params as any[])).rows as any[] };
  return { db, raw, now, env: { ADMIN_PASSWORD: 'pw-test', SESSION_SECRET: 'secret-test' } };
}

export const booking = (over: Record<string, unknown> = {}) => ({
  roomIds: ['room-2-north'], date: '2026-11-12', startTime: '10:00', endTime: '11:00',
  bookerName: '홍길동', meetingTitle: '주간 회의', pin: '1234', ...over,
});
