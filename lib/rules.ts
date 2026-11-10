export const OPEN_MIN = 8 * 60;
export const CLOSE_MIN = 20 * 60;
export const MAX_OCCURRENCES = 400;

export type RepeatType = 'NONE' | 'DAILY' | 'WEEKLY' | 'BIWEEKLY';
export type Scope = 'ONE' | 'FUTURE' | 'ALL';

export class ApiError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function toMin(time: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(String(time));
  if (!m) throw new ApiError(`시간 형식이 올바르지 않습니다: ${time}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function fromMin(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

export function validateSlot(startTime: string, endTime: string): { start: number; end: number } {
  const start = toMin(startTime);
  const end = toMin(endTime);
  if (start % 30 || end % 30) throw new ApiError('시간은 30분 단위로만 선택할 수 있습니다.');
  if (start < OPEN_MIN || end > CLOSE_MIN) throw new ApiError('예약 가능 시간은 08:00~20:00 입니다.');
  if (end <= start) throw new ApiError('종료 시간은 시작 시간보다 늦어야 합니다.');
  return { start, end };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertDate(value: string, label = '날짜'): string {
  if (!DATE_RE.test(String(value)) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new ApiError(`${label} 형식이 올바르지 않습니다: ${value}`);
  }
  return value;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function diffDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function isWeekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/** 반복 규칙에 따라 날짜 목록을 만든다. DAILY는 "평일마다"라 주말을 건너뛴다. */
export function expandDates(date: string, repeatType: RepeatType, repeatUntil: string): string[] {
  assertDate(date);
  if (repeatType === 'NONE') return [date];
  assertDate(repeatUntil, '반복 종료일');
  if (repeatUntil < date) throw new ApiError('반복 종료일은 시작일 이후여야 합니다.');

  const step = repeatType === 'WEEKLY' ? 7 : repeatType === 'BIWEEKLY' ? 14 : 1;
  const dates: string[] = [];
  for (let d = date; d <= repeatUntil; d = addDays(d, step)) {
    if (repeatType === 'DAILY' && isWeekend(d)) continue;
    dates.push(d);
    if (dates.length > MAX_OCCURRENCES) {
      throw new ApiError(`반복 예약은 최대 ${MAX_OCCURRENCES}건까지 가능합니다. 종료일을 줄여 주세요.`);
    }
  }
  return dates;
}

/** 14층만 방 2개를 동시에 잡을 수 있다. 그 외 층은 방 하나만. */
export function assertRoomSelection(rooms: { roomId: string; floor: number }[]): void {
  if (!rooms.length) throw new ApiError('회의실을 선택해 주세요.');
  if (rooms.length === 1) return;
  const sameFloor14 = rooms.every((r) => r.floor === 14);
  if (!sameFloor14 || rooms.length > 2) {
    throw new ApiError('여러 회의실 동시 예약은 14층 회의실 2개까지만 가능합니다.');
  }
}

export function assertPin(pin: string): string {
  if (!/^\d{4,8}$/.test(String(pin ?? ''))) throw new ApiError('PIN은 숫자 4~8자리여야 합니다.');
  return String(pin);
}

export function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}
