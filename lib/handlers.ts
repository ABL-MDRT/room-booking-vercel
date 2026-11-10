import { randomUUID } from 'node:crypto';
import { adminLogin, hashPin, requireAdmin, verifyPin, type AuthEnv } from './auth.js';
import { noCache, type Cache } from './cache.js';
import { isConstraintViolation, type Db, type Row } from './db.js';
import {
  ApiError, addDays, assertDate, assertPin, assertRoomSelection, diffDays, expandDates,
  fromMin, validateSlot, type RepeatType, type Scope,
} from './rules.js';

export interface Ctx {
  db: Db;
  env: AuthEnv;
  now: number;
  cache?: Cache;
}

const READ_TTL_SECONDS = 60;
export const CACHE_TAGS = ['reservations', 'members'];

interface Conflict { date: string; roomId: string; reason: string }
type WriteResult = { ok: true; count: number; reservationIds?: string[] } | { ok: false; conflicts: Conflict[] };

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const SELECT_RESERVATION = `
  SELECT r.reservation_id, r.group_id, r.repeat_type, r.room_id, to_char(r.date,'YYYY-MM-DD') AS d,
         r.start_min, r.end_min, r.booker_name, r.meeting_title, r.vp_attends, r.status, r.pin_hash,
         r.attendees, rm.name AS room_name, rm.floor, rm.direction, rm.capacity, rm.color
  FROM reservations r JOIN rooms rm ON rm.room_id = r.room_id`;

export function kstNow(now: number): { date: string; minutes: number } {
  const d = new Date(now + KST_OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

function toPublic(r: Row) {
  return {
    reservationId: r.reservation_id, reservationGroupId: r.group_id, repeatType: r.repeat_type,
    roomId: r.room_id, date: r.d, startTime: fromMin(r.start_min), endTime: fromMin(r.end_min),
    bookerName: r.booker_name, meetingTitle: r.meeting_title, vpAttends: r.vp_attends, status: r.status,
    roomName: r.room_name, floor: r.floor, direction: r.direction, capacity: r.capacity, color: r.color,
  };
}

async function listRooms(db: Db) {
  const rows = await db.query('SELECT * FROM rooms ORDER BY sort');
  return rows.map((r) => ({
    roomId: r.room_id, name: r.name, floor: r.floor, direction: r.direction, capacity: r.capacity, color: r.color,
  }));
}

function toMember(m: Row) {
  return {
    memberId: m.member_id, name: m.name, department: m.department, company: m.company,
    workFloor: m.work_floor, active: m.active,
  };
}

async function listMembers(db: Db, onlyActive: boolean) {
  const rows = await db.query(
    `SELECT * FROM members ${onlyActive ? 'WHERE active' : ''} ORDER BY company, name`,
  );
  return rows.map(toMember);
}

async function getBootstrap({ db, cache = noCache }: Ctx) {
  return cache.wrap('bootstrap', ['members'], READ_TTL_SECONDS, async () => ({
    rooms: await listRooms(db),
    members: await listMembers(db, true),
  }));
}

async function getInitialData(ctx: Ctx) {
  const today = kstNow(ctx.now).date;
  return {
    ...(await getBootstrap(ctx)),
    today,
    serverNowEpoch: ctx.now,
    reservations: await listReservations(ctx, { from: today, to: today }),
  };
}

async function listReservations(ctx: Ctx, q: { from?: string; to?: string; searchTerm?: string } = {}) {
  const { cache = noCache } = ctx;
  return cache.wrap(`reservations:${JSON.stringify([q.from ?? '', q.to ?? '', q.searchTerm ?? ''])}`,
    ['reservations'], READ_TTL_SECONDS, () => queryReservations(ctx.db, q));
}

async function queryReservations(db: Db, q: { from?: string; to?: string; searchTerm?: string }) {
  const where = [`r.status = 'ACTIVE'`];
  const params: unknown[] = [];
  if (q.from) { params.push(assertDate(q.from, '조회 시작일')); where.push(`r.date >= $${params.length}`); }
  if (q.to) { params.push(assertDate(q.to, '조회 종료일')); where.push(`r.date <= $${params.length}`); }
  const term = String(q.searchTerm ?? '').trim();
  if (term) {
    params.push(`%${term.replace(/[\\%_]/g, '\\$&')}%`);
    const p = `$${params.length}`;
    where.push(`(r.booker_name ILIKE ${p} OR r.meeting_title ILIKE ${p} OR r.attendees::text ILIKE ${p})`);
  }
  const rows = await db.query(
    `${SELECT_RESERVATION} WHERE ${where.join(' AND ')} ORDER BY r.date, r.start_min, rm.sort`,
    params,
  );
  return rows.map(toPublic);
}

interface Candidate { id: string; roomId: string; date: string; start: number; end: number }

async function findConflicts(db: Db, candidates: Candidate[], ignoreIds: string[]): Promise<Conflict[]> {
  if (!candidates.length) return [];
  const rows = await db.query(
    `SELECT DISTINCT c.room_id, to_char(c.d,'YYYY-MM-DD') AS d
     FROM unnest($1::text[], $2::date[], $3::int[], $4::int[]) AS c(room_id, d, s, e)
     JOIN reservations r ON r.room_id = c.room_id AND r.date = c.d AND r.status = 'ACTIVE'
      AND r.start_min < c.e AND r.end_min > c.s AND NOT (r.reservation_id = ANY($5::text[]))
     ORDER BY d`,
    [candidates.map((c) => c.roomId), candidates.map((c) => c.date),
     candidates.map((c) => c.start), candidates.map((c) => c.end), ignoreIds],
  );
  return rows.map((r) => ({ date: r.d, roomId: r.room_id, reason: '이미 예약된 시간입니다.' }));
}

function raceConflicts(candidates: { date: string; roomId: string }[]): Conflict[] {
  return candidates.map((c) => ({ date: c.date, roomId: c.roomId, reason: '방금 다른 예약이 먼저 등록되었습니다. 다시 확인해 주세요.' }));
}

async function loadRooms(db: Db, roomIds: string[]) {
  const rows = await db.query('SELECT * FROM rooms WHERE room_id = ANY($1::text[])', [roomIds]);
  const rooms = roomIds.map((id) => rows.find((r) => r.room_id === id));
  const missing = roomIds.filter((_, i) => !rooms[i]);
  if (missing.length) throw new ApiError(`존재하지 않는 회의실입니다: ${missing.join(', ')}`);
  return rooms.map((r) => ({ roomId: r!.room_id as string, floor: r!.floor as number }));
}

function assertNotPast(candidates: Candidate[], now: number): Conflict[] {
  const t = kstNow(now);
  return candidates
    .filter((c) => c.date < t.date || (c.date === t.date && c.end <= t.minutes))
    .map((c) => ({ date: c.date, roomId: c.roomId, reason: '이미 지난 시간은 예약할 수 없습니다.' }));
}

interface CreateInput {
  roomIds: string[]; date: string; startTime: string; endTime: string; bookerName: string;
  bookerMemberId?: string; attendees?: unknown[]; bookerAttends?: boolean; meetingTitle: string;
  vpAttends?: boolean; pin: string; repeatType?: RepeatType; repeatUntil?: string; requestId?: string;
}

async function createReservation(ctx: Ctx, p: CreateInput): Promise<WriteResult> {
  const { db, now } = ctx;
  const bookerName = String(p.bookerName ?? '').trim();
  const meetingTitle = String(p.meetingTitle ?? '').trim();
  if (!bookerName) throw new ApiError('예약자 이름을 입력해 주세요.');
  if (!meetingTitle) throw new ApiError('회의 제목을 입력해 주세요.');
  if (meetingTitle.length > 60) throw new ApiError('회의 제목은 60자 이내로 입력해 주세요.');
  const pin = assertPin(p.pin);
  const slot = validateSlot(p.startTime, p.endTime);
  const repeatType = (p.repeatType ?? 'NONE') as RepeatType;
  const dates = expandDates(assertDate(p.date), repeatType, p.repeatUntil ?? '');
  const roomIds = [...new Set(p.roomIds ?? [])];
  assertRoomSelection(await loadRooms(db, roomIds));

  if (p.requestId) {
    const prior = await db.query(`SELECT reservation_id FROM reservations WHERE request_id = $1`, [p.requestId]);
    if (prior.length) return { ok: true, count: prior.length, reservationIds: prior.map((r) => r.reservation_id) };
  }

  const candidates: Candidate[] = roomIds.flatMap((roomId) =>
    dates.map((date) => ({ id: randomUUID(), roomId, date, start: slot.start, end: slot.end })));
  const blocked = [...assertNotPast(candidates, now), ...(await findConflicts(db, candidates, []))];
  if (blocked.length) return { ok: false, conflicts: blocked };

  const pinHash = hashPin(pin);
  const groupByRoom = new Map(roomIds.map((id) => [id, randomUUID()]));
  const attendees = JSON.stringify(p.attendees ?? []);
  const params: unknown[] = [];
  const tuples = candidates.map((c) => {
    params.push(c.id, groupByRoom.get(c.roomId), repeatType, c.roomId, c.date, c.start, c.end, bookerName,
      p.bookerMemberId ?? '', attendees, p.bookerAttends !== false, meetingTitle, p.vpAttends === true,
      pinHash, p.requestId ?? null);
    const n = params.length - 14;
    return `(${Array.from({ length: 15 }, (_, i) => `$${n + i}`).join(',')})`;
  });
  try {
    await db.query(
      `INSERT INTO reservations (reservation_id, group_id, repeat_type, room_id, date, start_min, end_min,
        booker_name, booker_member_id, attendees, booker_attends, meeting_title, vp_attends, pin_hash, request_id)
       VALUES ${tuples.join(',')}`,
      params,
    );
  } catch (err) {
    if (isConstraintViolation(err)) return { ok: false, conflicts: raceConflicts(candidates) };
    throw err;
  }
  return { ok: true, count: candidates.length, reservationIds: candidates.map((c) => c.id) };
}

async function loadScope(db: Db, id: string, scope: Scope): Promise<{ target: Row; rows: Row[] }> {
  const found = await db.query(`${SELECT_RESERVATION} WHERE r.reservation_id = $1 AND r.status = 'ACTIVE'`, [id]);
  const target = found[0];
  if (!target) throw new ApiError('예약을 찾을 수 없거나 이미 취소되었습니다.', 404);
  if (scope === 'ONE') return { target, rows: [target] };
  const group = await db.query(
    `${SELECT_RESERVATION} WHERE r.group_id = $1 AND r.status = 'ACTIVE' ORDER BY r.date`, [target.group_id]);
  return { target, rows: scope === 'ALL' ? group : group.filter((r) => r.d > target.d) };
}

function parseScope(scope: string): Scope {
  if (scope !== 'ONE' && scope !== 'FUTURE' && scope !== 'ALL') throw new ApiError(`적용 범위가 올바르지 않습니다: ${scope}`);
  return scope;
}

interface Changes {
  roomId: string; date: string; startTime: string; endTime: string;
  bookerName: string; meetingTitle: string; vpAttends: boolean;
}

async function applyUpdate(ctx: Ctx, target: Row, rows: Row[], c: Changes): Promise<WriteResult> {
  const { db } = ctx;
  const bookerName = String(c.bookerName ?? '').trim();
  const meetingTitle = String(c.meetingTitle ?? '').trim();
  if (!bookerName) throw new ApiError('예약자 이름을 입력해 주세요.');
  if (!meetingTitle) throw new ApiError('회의 제목을 입력해 주세요.');
  const slot = validateSlot(c.startTime, c.endTime);
  await loadRooms(db, [c.roomId]);
  const delta = diffDays(target.d, assertDate(c.date));
  const next = rows.map((r) => ({ id: r.reservation_id as string, roomId: c.roomId, date: addDays(r.d, delta), start: slot.start, end: slot.end }));

  const blocked = await findConflicts(db, next, rows.map((r) => r.reservation_id));
  if (blocked.length) return { ok: false, conflicts: blocked };
  if (!next.length) return { ok: true, count: 0 };
  try {
    await db.query(
      `UPDATE reservations r SET room_id = $2, date = u.d, start_min = $3, end_min = $4, booker_name = $5,
         meeting_title = $6, vp_attends = $7, updated_at = now()
       FROM unnest($1::text[], $8::date[]) AS u(id, d) WHERE r.reservation_id = u.id`,
      [next.map((n) => n.id), c.roomId, slot.start, slot.end, bookerName, meetingTitle, c.vpAttends === true,
       next.map((n) => n.date)],
    );
  } catch (err) {
    if (isConstraintViolation(err)) return { ok: false, conflicts: raceConflicts(next.map((n) => ({ date: n.date, roomId: n.roomId }))) };
    throw err;
  }
  return { ok: true, count: next.length };
}

async function updateOwnReservation(ctx: Ctx, id: string, pin: string, changes: Changes, scope: string) {
  const { target, rows } = await loadScope(ctx.db, id, parseScope(scope));
  if (!verifyPin(String(pin ?? ''), target.pin_hash)) throw new ApiError('수정·취소 PIN이 올바르지 않습니다.', 403);
  return applyUpdate(ctx, target, rows, changes);
}

async function cancelRows(db: Db, rows: Row[], reason: string, by: 'USER' | 'ADMIN') {
  if (!rows.length) return { ok: true, count: 0 };
  await db.query(
    `UPDATE reservations SET status = 'CANCELLED', cancel_reason = $2, cancelled_by = $3, updated_at = now()
     WHERE reservation_id = ANY($1::text[])`,
    [rows.map((r) => r.reservation_id), reason, by],
  );
  return { ok: true, count: rows.length };
}

async function cancelOwnReservation({ db }: Ctx, id: string, pin: string, scope: string) {
  const { target, rows } = await loadScope(db, id, parseScope(scope));
  if (!verifyPin(String(pin ?? ''), target.pin_hash)) throw new ApiError('수정·취소 PIN이 올바르지 않습니다.', 403);
  return cancelRows(db, rows, '', 'USER');
}

async function adminListAll(ctx: Ctx, token: string, searchTerm = '') {
  requireAdmin(token, ctx.env, ctx.now);
  return listReservations(ctx, { searchTerm });
}

async function adminUpdateReservation(ctx: Ctx, token: string, id: string, changes: Changes, scope: string) {
  requireAdmin(token, ctx.env, ctx.now);
  const { target, rows } = await loadScope(ctx.db, id, parseScope(scope));
  return applyUpdate(ctx, target, rows, changes);
}

async function adminCancelReservation(ctx: Ctx, token: string, id: string, reason: string, scope: string) {
  requireAdmin(token, ctx.env, ctx.now);
  const { rows } = await loadScope(ctx.db, id, parseScope(scope));
  return cancelRows(ctx.db, rows, String(reason ?? '').trim(), 'ADMIN');
}

async function adminListMembers(ctx: Ctx, token: string) {
  requireAdmin(token, ctx.env, ctx.now);
  return listMembers(ctx.db, false);
}

async function adminSaveMember(ctx: Ctx, token: string, m: { name: string; department: string }) {
  requireAdmin(token, ctx.env, ctx.now);
  const name = String(m?.name ?? '').trim();
  const company = String(m?.department ?? '').trim();
  if (!name) throw new ApiError('구성원 이름을 입력해 주세요.');
  if (!company) throw new ApiError('회사를 선택해 주세요.');
  const memberId = `m-${randomUUID()}`;
  // 원본 화면이 회사 선택값을 department 필드로 보낸다. company에도 같이 저장해 필터가 동작하게 한다.
  await ctx.db.query(
    `INSERT INTO members (member_id, name, department, company) VALUES ($1, $2, $3, $3)`,
    [memberId, name, company],
  );
  return { ok: true, memberId };
}

async function adminToggleMember(ctx: Ctx, token: string, id: string, active: boolean) {
  requireAdmin(token, ctx.env, ctx.now);
  const rows = await ctx.db.query(`UPDATE members SET active = $2 WHERE member_id = $1 RETURNING member_id`, [id, active === true || String(active) === 'true']);
  if (!rows.length) throw new ApiError('구성원을 찾을 수 없습니다.', 404);
  return { ok: true };
}

type Handler = (ctx: Ctx, ...args: any[]) => Promise<unknown>;

export const handlers: Record<string, Handler> = {
  getBootstrap, getInitialData, listReservations, createReservation,
  updateOwnReservation, cancelOwnReservation,
  adminLogin: async (ctx, password: string) => adminLogin(password, ctx.env, ctx.now),
  adminListAll, adminUpdateReservation, adminCancelReservation,
  adminListMembers, adminSaveMember, adminToggleMember,
};

/** 예약·구성원 목록에 영향을 주는 쓰기 함수. 성공하면 조회 캐시를 비운다. */
export const WRITE_FUNCTIONS = new Set([
  'createReservation', 'updateOwnReservation', 'cancelOwnReservation',
  'adminUpdateReservation', 'adminCancelReservation', 'adminSaveMember', 'adminToggleMember',
]);

/** 원본 프론트는 createReservation만 객체 하나를, 나머지는 인자 배열을 본문으로 보낸다. */
export function toArgs(fn: string, payload: unknown): unknown[] {
  if (fn === 'createReservation') return [payload];
  return Array.isArray(payload) ? payload : [payload];
}
