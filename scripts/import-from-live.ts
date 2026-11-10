import { hashPin } from '../lib/auth.js';
import { assertPin } from '../lib/rules.js';
import { applySchema, openDb } from './local-db.js';

const BASE = process.env.LIVE_BASE ?? 'https://woori-meeting-room.kro.kr';
const FROM = '2020-01-01';
const TO = '2099-12-31';

async function rpc<T>(fn: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api/${fn}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${fn} 호출 실패: HTTP ${res.status} (${BASE})`);
  return (await res.json()) as T;
}

// 원본 PIN은 못 받아서, 가져온 예약은 전부 같은 PIN으로 통일한다(사용자 결정). 바꾸려면 IMPORT_PIN.
const IMPORT_PIN = assertPin(process.env.IMPORT_PIN ?? '1234');
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

const { db, target } = await openDb();
console.log(`가져올 곳: ${target}`);
await applySchema(db);

const boot = await rpc<{ members: any[] }>('getBootstrap', []);
// 전화번호는 새 서비스에 옮기지 않는다 (공개 API에 노출되던 값이라 보관할 이유가 없다).
for (const m of boot.members) {
  await db.query(
    `INSERT INTO members (member_id, name, department, company, work_floor, active)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (member_id) DO NOTHING`,
    [m.memberId, m.name, m.department ?? '', m.company ?? '', String(m.workFloor ?? ''), m.active !== false]);
}

const list = await rpc<any[]>('listReservations', { from: FROM, to: TO });
let inserted = 0;
for (const r of list) {
  const res = await db.query(
    `INSERT INTO reservations (reservation_id, group_id, repeat_type, room_id, date, start_min, end_min,
       booker_name, meeting_title, vp_attends, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ACTIVE') ON CONFLICT (reservation_id) DO NOTHING RETURNING 1`,
    [r.reservationId, r.reservationGroupId || r.reservationId, r.repeatType || 'NONE', r.roomId, r.date,
     toMin(r.startTime), toMin(r.endTime), r.bookerName, r.meetingTitle ?? '', r.vpAttends === true]);
  inserted += res.length;
}
const pinned = await db.query(
  `UPDATE reservations SET pin_hash = $1 WHERE pin_hash IS NULL RETURNING 1`, [hashPin(IMPORT_PIN)]);
console.log(`PIN이 없던 예약 ${pinned.length}건에 통일 PIN 설정`);
console.log(`구성원 ${boot.members.length}명, 예약 ${list.length}건 중 ${inserted}건 새로 넣음`);
