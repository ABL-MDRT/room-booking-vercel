import { beforeEach, describe, expect, it } from 'vitest';
import { handlers } from '../lib/handlers.js';
import { booking, makeCtx } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeCtx>>;
const call = (fn: string, ...args: unknown[]) => handlers[fn](ctx, ...args) as Promise<any>;
beforeEach(async () => { ctx = await makeCtx(); });

describe('관리자', () => {
  it('비밀번호가 틀리면 ok:false, 맞으면 토큰을 준다', async () => {
    expect(await call('adminLogin', 'x')).toEqual({ ok: false });
    const r = await call('adminLogin', 'pw-test');
    expect(r.ok).toBe(true);
    expect(r.token).toBeTruthy();
  });

  it('토큰 없이 관리자 함수를 부르면 401', async () => {
    await expect(call('adminListAll', '', '')).rejects.toMatchObject({ status: 401 });
    await expect(call('adminListMembers', 'a.b')).rejects.toMatchObject({ status: 401 });
  });

  it('만료된 토큰은 거절한다', async () => {
    const { token } = await call('adminLogin', 'pw-test');
    ctx.now += 13 * 60 * 60 * 1000;
    await expect(call('adminListAll', token, '')).rejects.toMatchObject({ status: 401 });
  });

  it('PIN 없이 관리자 권한으로 취소·수정한다', async () => {
    const { token } = await call('adminLogin', 'pw-test');
    await call('createReservation', booking());
    const [r] = await call('adminListAll', token, '');
    const upd = await call('adminUpdateReservation', token, r.reservationId, {
      roomId: 'room-2-south', date: '2026-11-12', startTime: '10:00', endTime: '11:00',
      bookerName: '홍길동', meetingTitle: '관리자 수정', vpAttends: true }, 'ONE');
    expect(upd).toMatchObject({ ok: true, count: 1 });
    expect(await call('adminCancelReservation', token, r.reservationId, '시설 점검', 'ONE')).toMatchObject({ count: 1 });
    expect(await call('adminListAll', token, '')).toHaveLength(0);
  });

  it('구성원 추가·비활성화가 부트스트랩에 반영된다', async () => {
    const { token } = await call('adminLogin', 'pw-test');
    const { memberId } = await call('adminSaveMember', token, { name: '신입', department: 'ABL' });
    expect((await call('getBootstrap')).members.map((m: any) => m.name)).toContain('신입');
    await call('adminToggleMember', token, memberId, false);
    expect((await call('getBootstrap')).members.map((m: any) => m.name)).not.toContain('신입');
    expect((await call('adminListMembers', token)).map((m: any) => m.name)).toContain('신입');
  });

  it('공개 부트스트랩 응답에 전화번호가 없다', async () => {
    await ctx.raw.query(`INSERT INTO members (member_id, name) VALUES ('m1','테스트')`);
    expect(JSON.stringify(await call('getBootstrap'))).not.toMatch(/phone/i);
  });
});
