import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBankHoliday, nextBusinessDay, prevBusinessDay, payDate, ymd, holidaysIn }
  from './holidays.js';

test('주말은 은행이 쉰다', () => {
  assert.equal(isBankHoliday(new Date(2026, 8, 19)), true, '2026-09-19 토');
  assert.equal(isBankHoliday(new Date(2026, 8, 20)), true, '일');
  assert.equal(isBankHoliday(new Date(2026, 8, 21)), false, '월');
});

test('근로자의날에도 이체는 안 돈다', () => {
  assert.equal(isBankHoliday(new Date(2026, 4, 1)), true, '공휴일은 아니지만 은행이 쉰다');
});

test('나가는 돈은 미뤄진다 — 10일 토요일이면 12일 월요일', () => {
  const out = nextBusinessDay(new Date(2026, 9, 10));      // 2026-10-10 토
  assert.equal(ymd(out), '2026-10-12');
});

test('들어오는 돈은 앞당겨진다 — 5일 일요일이면 3일 금요일', () => {
  const inn = prevBusinessDay(new Date(2026, 6, 5));       // 2026-07-05 일
  assert.equal(ymd(inn), '2026-07-03');
});

test('영업일이면 그날 그대로', () => {
  assert.equal(ymd(nextBusinessDay(new Date(2026, 8, 10))), '2026-09-10', '목요일');
  assert.equal(ymd(prevBusinessDay(new Date(2026, 8, 10))), '2026-09-10');
});

test('연휴를 통째로 건너뛴다', () => {
  // 2026 설 연휴 2/16(월)~2/18(수)
  assert.equal(ymd(nextBusinessDay(new Date(2026, 1, 16))), '2026-02-19');
  assert.equal(ymd(prevBusinessDay(new Date(2026, 1, 18))), '2026-02-13', '앞은 주말까지 넘는다');
});

test('주말과 겹친 공휴일은 대체공휴일이 붙는다', () => {
  const h = holidaysIn(2026);
  assert.ok(h.has('2026-03-01'), '삼일절은 일요일');
  assert.ok(h.has('2026-03-02'), '그래서 월요일이 대체공휴일');
  assert.ok(!h.has('2026-01-02'), '신정은 대체공휴일이 없다');
});

test('직접 넣은 쉬는 날도 본다', () => {
  assert.equal(isBankHoliday(new Date(2028, 1, 15)), false);
  assert.equal(isBankHoliday(new Date(2028, 1, 15), ['2028-02-15']), true,
    '표에 없는 해는 설정에서 넣어 메운다');
});

test('그 달에 실제로 돈이 오가는 날', () => {
  assert.equal(ymd(payDate(2026, 9, 10, 'out')), '2026-10-12', '카드값은 미뤄지고');
  assert.equal(ymd(payDate(2026, 6, 5, 'in')), '2026-07-03', '월급은 앞당겨진다');
  assert.equal(ymd(payDate(2026, 1, 31, 'out')), '2026-03-03',
    '없는 날짜는 그 달 마지막 날로. 2/28 토 → 3/1 삼일절(일) → 3/2 대체공휴일 → 3/3');
});
