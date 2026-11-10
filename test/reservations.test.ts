import { beforeEach, describe, expect, it } from 'vitest';
import { handlers } from '../lib/handlers.js';
import { booking, makeCtx } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeCtx>>;
const call = (fn: string, ...args: unknown[]) => handlers[fn](ctx, ...args) as Promise<any>;
beforeEach(async () => { ctx = await makeCtx(); });

describe('createReservation', () => {
  it('정상 예약을 만들고 목록에서 조회된다', async () => {
    const r = await call('createReservation', booking());
    expect(r).toMatchObject({ ok: true, count: 1 });
    const list = await call('listReservations', { from: '2026-11-12', to: '2026-11-12' });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ roomName: '2층 1회의실', startTime: '10:00', endTime: '11:00', date: '2026-11-12' });
    expect(list[0]).not.toHaveProperty('pin');
  });

  it('같은 방·겹치는 시간은 conflicts로 거절한다', async () => {
    await call('createReservation', booking());
    const r = await call('createReservation', booking({ startTime: '10:30', endTime: '11:30' }));
    expect(r.ok).toBe(false);
    expect(r.conflicts[0]).toMatchObject({ date: '2026-11-12', roomId: 'room-2-north' });
  });

  it('끝나는 시각과 시작 시각이 맞닿는 예약은 겹침이 아니다', async () => {
    await call('createReservation', booking());
    const r = await call('createReservation', booking({ startTime: '11:00', endTime: '12:00' }));
    expect(r.ok).toBe(true);
  });

  it('동시에 같은 시간을 잡으면 한 건만 성공한다 (DB 제약)', async () => {
    const results = await Promise.all(
      [1, 2, 3, 4].map((i) => call('createReservation', booking({ bookerName: `사용자${i}` }))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const list = await call('listReservations', {});
    expect(list).toHaveLength(1);
  });

  it('같은 requestId로 다시 보내면 중복 생성하지 않는다', async () => {
    await call('createReservation', booking({ requestId: 'req-1' }));
    const again = await call('createReservation', booking({ requestId: 'req-1' }));
    expect(again).toMatchObject({ ok: true, count: 1 });
    expect(await call('listReservations', {})).toHaveLength(1);
  });

  it.each([
    ['08:00 이전', { startTime: '07:30', endTime: '09:00' }],
    ['20:00 이후', { startTime: '19:30', endTime: '20:30' }],
    ['30분 단위가 아님', { startTime: '10:15', endTime: '11:00' }],
    ['종료가 시작보다 이름', { startTime: '11:00', endTime: '10:00' }],
    ['PIN이 3자리', { pin: '123' }],
    ['제목이 비어 있음', { meetingTitle: '  ' }],
    ['없는 회의실', { roomIds: ['room-99'] }],
    ['2층 방 2개 동시', { roomIds: ['room-2-north', 'room-2-south'] }],
  ])('잘못된 입력은 예외: %s', async (_name, over) => {
    await expect(call('createReservation', booking(over))).rejects.toThrow();
  });

  it('14층은 방 2개를 한 번에 잡을 수 있다', async () => {
    const r = await call('createReservation', booking({ roomIds: ['room-14-east', 'room-14-west'] }));
    expect(r).toMatchObject({ ok: true, count: 2 });
  });

  it('지난 시간은 예약할 수 없다', async () => {
    const r = await call('createReservation', booking({ date: '2026-11-09' }));
    expect(r.ok).toBe(false);
    expect(r.conflicts[0].reason).toContain('지난');
  });

  it('평일 반복은 주말을 건너뛰고 한 건이라도 충돌하면 전부 만들지 않는다', async () => {
    await call('createReservation', booking({ date: '2026-11-18' })); // 수
    const r = await call('createReservation', booking({ date: '2026-11-16', repeatType: 'DAILY', repeatUntil: '2026-11-20' }));
    expect(r.ok).toBe(false);
    expect(await call('listReservations', {})).toHaveLength(1);
    const ok = await call('createReservation', booking({ date: '2026-11-13', repeatType: 'DAILY', repeatUntil: '2026-11-17', roomIds: ['room-2-south'] }));
    expect(ok.count).toBe(3); // 금, 월, 화 (토·일 제외)
  });

  it('매주 반복은 7일 간격으로 만든다', async () => {
    const r = await call('createReservation', booking({ date: '2026-11-12', repeatType: 'WEEKLY', repeatUntil: '2026-12-03' }));
    expect(r.count).toBe(4);
  });
});

describe('수정·취소', () => {
  const series = () => call('createReservation', booking({ date: '2026-11-12', repeatType: 'WEEKLY', repeatUntil: '2026-12-03' }));
  const ids = async () => (await call('listReservations', {})).map((x: any) => x.reservationId);
  const changes = (over = {}) => ({ roomId: 'room-2-north', date: '2026-11-12', startTime: '14:00', endTime: '15:00', bookerName: '홍길동', meetingTitle: '변경', vpAttends: false, ...over });

  it('PIN이 틀리면 403으로 거절한다', async () => {
    await call('createReservation', booking());
    const [id] = await ids();
    await expect(call('cancelOwnReservation', id, '9999', 'ONE')).rejects.toMatchObject({ status: 403 });
    await expect(call('updateOwnReservation', id, '9999', changes(), 'ONE')).rejects.toMatchObject({ status: 403 });
  });

  it('ONE은 한 건만, ALL은 시리즈 전체를 취소한다', async () => {
    await series();
    const [first] = await ids();
    expect(await call('cancelOwnReservation', first, '1234', 'ONE')).toMatchObject({ count: 1 });
    expect(await ids()).toHaveLength(3);
    const [second] = await ids();
    expect(await call('cancelOwnReservation', second, '1234', 'ALL')).toMatchObject({ count: 3 });
    expect(await ids()).toHaveLength(0);
  });

  it('FUTURE는 선택한 예약을 제외한 이후 예약만 취소한다', async () => {
    await series();
    const [first] = await ids();
    expect(await call('cancelOwnReservation', first, '1234', 'FUTURE')).toMatchObject({ count: 3 });
    expect(await ids()).toEqual([first]);
  });

  it('취소한 시간은 다시 예약할 수 있다', async () => {
    await call('createReservation', booking());
    const [id] = await ids();
    await call('cancelOwnReservation', id, '1234', 'ONE');
    expect((await call('createReservation', booking())).ok).toBe(true);
  });

  it('수정 시 날짜 변경분이 시리즈 전체에 같은 간격으로 적용된다', async () => {
    await series();
    const [first] = await ids();
    const r = await call('updateOwnReservation', first, '1234', changes({ date: '2026-11-13' }), 'ALL');
    expect(r).toMatchObject({ ok: true, count: 4 });
    const dates = (await call('listReservations', {})).map((x: any) => x.date);
    expect(dates).toEqual(['2026-11-13', '2026-11-20', '2026-11-27', '2026-12-04']);
  });

  it('다른 예약과 겹치게 수정하면 conflicts를 돌려주고 원본은 그대로다', async () => {
    await call('createReservation', booking({ startTime: '14:00', endTime: '15:00' }));
    await call('createReservation', booking({ startTime: '09:00', endTime: '10:00' }));
    const target = (await call('listReservations', {})).find((x: any) => x.startTime === '09:00');
    const r = await call('updateOwnReservation', target.reservationId, '1234', changes(), 'ONE');
    expect(r.ok).toBe(false);
    const again = (await call('listReservations', {})).find((x: any) => x.reservationId === target.reservationId);
    expect(again.startTime).toBe('09:00');
  });

  it('자기 자신과 겹치는 시간대로 수정하는 건 허용한다', async () => {
    await call('createReservation', booking());
    const [id] = await ids();
    expect((await call('updateOwnReservation', id, '1234', changes({ startTime: '10:00', endTime: '12:00' }), 'ONE')).ok).toBe(true);
  });
});

describe('조회 검색', () => {
  it('예약자·제목·참석자 이름으로 검색한다', async () => {
    await call('createReservation', booking({ bookerName: '김철수', meetingTitle: '분기 결산', attendees: [{ name: '이영희' }] }));
    for (const term of ['김철수', '결산', '이영희']) {
      expect(await call('listReservations', { searchTerm: term })).toHaveLength(1);
    }
    expect(await call('listReservations', { searchTerm: '없는사람' })).toHaveLength(0);
  });

  it('검색어의 % 는 와일드카드가 아니라 글자로 취급한다', async () => {
    await call('createReservation', booking());
    expect(await call('listReservations', { searchTerm: '%' })).toHaveLength(0);
  });
});

describe('DB 배타 제약', () => {
  const insert = (id: string, s: number, e: number, status = 'ACTIVE') => ctx.raw.query(
    `INSERT INTO reservations (reservation_id, group_id, room_id, date, start_min, end_min, booker_name, status)
     VALUES ($1, $1, 'room-2-north', '2026-11-12', $2, $3, 'x', $4)`, [id, s, e, status]);

  it('사전 검사를 우회해 직접 넣어도 겹치는 ACTIVE 행은 DB가 거절한다', async () => {
    await insert('a', 600, 660);
    await expect(insert('b', 630, 690)).rejects.toMatchObject({ code: '23P01' });
  });

  it('CANCELLED 행은 제약에서 제외된다', async () => {
    await insert('a', 600, 660, 'CANCELLED');
    await expect(insert('b', 600, 660)).resolves.toBeDefined();
  });
});

describe('경쟁 충돌 응답', () => {
  it('내부 필드(id·start·end) 없이 date·roomId·reason만 돌려준다', async () => {
    const racing = { ...ctx.db, query: async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('INSERT INTO reservations')) throw Object.assign(new Error('x'), { code: '23P01' });
      return ctx.db.query(sql, params);
    } };
    const r = (await handlers.createReservation({ ...ctx, db: racing }, booking())) as any;
    expect(r.ok).toBe(false);
    expect(Object.keys(r.conflicts[0]).sort()).toEqual(['date', 'reason', 'roomId']);
  });
});
