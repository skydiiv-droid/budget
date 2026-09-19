import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShiftText, shiftText, shiftDateOf, shiftStats } from './shifts.js';

test('하루 한 글자로 죽 적으면 읽는다', () => {
  const s = parseShiftText('DDEENNOO', '2026-09');
  assert.equal(s['2026-09-01'], 'day');
  assert.equal(s['2026-09-03'], 'evening');
  assert.equal(s['2026-09-05'], 'night');
  assert.equal(s['2026-09-07'], 'off');
  assert.equal(Object.keys(s).length, 8);
});

test('띄어쓰기와 줄바꿈은 넘긴다', () => {
  assert.deepEqual(parseShiftText('D D E\nE, N', '2026-09'),
                   parseShiftText('DDEEN', '2026-09'));
});

test('한글로 적어도 알아듣는다', () => {
  const s = parseShiftText('데데이이나나오오', '2026-09');
  assert.equal(s['2026-09-01'], 'day');
  assert.equal(s['2026-09-05'], 'night');
});

test('그 달 날 수를 넘기면 버린다', () => {
  const s = parseShiftText('D'.repeat(40), '2026-02');
  assert.equal(Object.keys(s).length, 28);
});

test('다시 글자로 돌려 놓는다', () => {
  const s = parseShiftText('DDEENNOO', '2026-09');
  assert.ok(shiftText(s, '2026-09').startsWith('DDEENNOO'));
  assert.equal(shiftText(s, '2026-09').length, 30);
  assert.ok(shiftText(s, '2026-09').includes('·'), '안 적은 날은 비워 둔다');
});

test('새벽에 쓴 돈은 앞날 근무로 친다', () => {
  assert.equal(shiftDateOf('2026-09-20T03:20:00'), '2026-09-19',
    '나이트 도중에 산 커피는 그 나이트에 쓴 돈이다');
  assert.equal(shiftDateOf('2026-09-20T09:00:00'), '2026-09-20');
});

const buy = (date, time, amount) => ({
  id: date + time, type: 'expense', amount,
  occurredAt: `2026-09-${date}T${time}:00`,
});

test('총액이 아니라 하루 평균으로 낸다', () => {
  // 나이트 2일(19·20), 오프 4일(21~24)
  const shifts = {
    '2026-09-19': 'night', '2026-09-20': 'night',
    '2026-09-21': 'off', '2026-09-22': 'off', '2026-09-23': 'off', '2026-09-24': 'off',
  };
  const transactions = [
    buy('19', '22:00', 30_000), buy('20', '22:00', 30_000),      // 나이트 6만 / 2일
    buy('21', '12:00', 20_000), buy('22', '12:00', 20_000),
    buy('23', '12:00', 20_000), buy('24', '12:00', 20_000),      // 오프 8만 / 4일
  ];
  const s = shiftStats({ transactions, shifts });
  const night = s.items.find((i) => i.id === 'night');
  const off = s.items.find((i) => i.id === 'off');
  assert.equal(night.perDay, 30_000);
  assert.equal(off.perDay, 20_000);
  assert.equal(s.items[0].id, 'night', '많이 쓰는 근무가 먼저');
  assert.equal(off.total, 80_000, '총액만 보면 오프가 더 커 보인다');
});

test('나이트 다음 날을 따로 센다', () => {
  const shifts = {
    '2026-09-18': 'night', '2026-09-19': 'off',
    '2026-09-25': 'off',
  };
  const transactions = [buy('19', '13:00', 32_000), buy('25', '13:00', 8_000)];
  const s = shiftStats({ transactions, shifts });
  assert.equal(s.afterNight.days, 1);
  assert.equal(s.afterNight.perDay, 32_000);
  assert.equal(s.items.find((i) => i.id === 'off').perDay, 20_000,
    '오프 전체 평균과는 다르다 — 그래서 따로 센다');
});

test('근무표에 없는 날은 세지 않는다', () => {
  const s = shiftStats({
    shifts: { '2026-09-19': 'night' },
    transactions: [buy('19', '13:00', 10_000), buy('28', '13:00', 99_000)],
  });
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].total, 10_000);
});

test('예산에서 뺀 건은 세지 않는다', () => {
  const s = shiftStats({
    shifts: { '2026-09-19': 'off' },
    transactions: [{ ...buy('19', '13:00', 50_000), excludeFromBudget: true }],
  });
  assert.equal(s.items[0].perDay, 0);
});

test('근무 사이 차이가 없으면 볼 게 없다', () => {
  const s = shiftStats({
    shifts: { '2026-09-19': 'night', '2026-09-20': 'off' },
    transactions: [buy('19', '13:00', 10_000), buy('20', '13:00', 10_000)],
  });
  assert.equal(s.gap, 0);
});
