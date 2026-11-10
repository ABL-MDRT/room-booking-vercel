import { neon } from '@neondatabase/serverless';

export type Row = Record<string, any>;

/** 핸들러가 의존하는 최소 DB 인터페이스. 운영은 Neon, 테스트는 PGlite가 구현한다. */
export interface Db {
  query(sql: string, params?: unknown[]): Promise<Row[]>;
}

export function connectNeon(url = process.env.DATABASE_URL): Db {
  if (!url) throw new Error('DATABASE_URL 환경변수가 없습니다.');
  const sql = neon(url);
  return { query: async (text, params = []) => (await sql.query(text, params)) as Row[] };
}

/** Postgres 제약 위반(23P01: 배타 제약, 23505: 유니크) 여부. */
export function isConstraintViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === '23P01' || code === '23505';
}
