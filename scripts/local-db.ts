import { mkdirSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { connectNeon, type Db } from '../lib/db.js';

export const SCHEMA_SQL = readFileSync(new URL('../lib/schema.sql', import.meta.url), 'utf8');

export const ROOM_SEED = [
  ['room-2-north', '2층 1회의실', 2, '북쪽', 10, '#0067b9'],
  ['room-2-south', '2층 2회의실', 2, '남쪽', 10, '#00a5df'],
  ['room-10-north', '10층 1회의실', 10, '북쪽', 10, '#078653'],
  ['room-10-south', '10층 2회의실', 10, '남쪽', 10, '#8b5cf6'],
  ['room-14-east', '14층 1회의실', 14, '북쪽', 16, '#f97316'],
  ['room-14-west', '14층 2회의실', 14, '남쪽', 16, '#d946ef'],
  ['room-15-a', '15층 1회의실', 15, '북쪽', 10, '#14b8a6'],
  ['room-15-b', '15층 2회의실', 15, '남쪽', 10, '#64748b'],
] as const;

/** DATABASE_URL이 있으면 Neon, 없으면 data/pg 에 저장되는 로컬 PGlite. */
export async function openDb(): Promise<{ db: Db; target: string }> {
  if (process.env.DATABASE_URL) return { db: connectNeon(), target: 'Neon(DATABASE_URL)' };
  mkdirSync('data', { recursive: true });
  const raw = new PGlite('data/pg', { extensions: { btree_gist } });
  return { db: { query: async (sql, params) => (await raw.query(sql, (params ?? []) as any[])).rows as any[] }, target: '로컬 PGlite(data/pg)' };
}

export async function applySchema(db: Db): Promise<void> {
  // Neon http 드라이버는 한 번에 한 문장만 실행하므로 문장 단위로 나눠 보낸다.
  for (const stmt of SCHEMA_SQL.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await db.query(stmt);
  for (const [i, r] of ROOM_SEED.entries()) {
    await db.query(
      `INSERT INTO rooms (room_id, name, floor, direction, capacity, color, sort) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (room_id) DO UPDATE SET name=EXCLUDED.name, floor=EXCLUDED.floor,
         direction=EXCLUDED.direction, capacity=EXCLUDED.capacity, color=EXCLUDED.color, sort=EXCLUDED.sort`, [...r, i + 1]);
  }
}
