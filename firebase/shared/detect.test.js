import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRecurring } from './detect.js';

const buy = (month, day, amount, merchant, extra = {}) => ({
  id: `${merchant}${month}`, type: 'expense', amount, merchantRaw: merchant,
  occurredAt: `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T12:00:00`,
  ...extra,
});
const find = (transactions, rest = {}) => detectRecurring({ transactions, ...rest });

test('두 달 이상 같은 날 같은 곳이면 고정비로 본다', () => {
  const [s] = find([buy(7, 14, 17_000, '넷플릭스'), buy(8, 14, 17_000, '넷플릭스'),
                    buy(9, 14, 17_000, '넷플릭스')]);
  assert.equal(s.name, '넷플릭스');
  assert.equal(s.dayOfMonth, 14);
  assert.equal(s.expectedAmount, 17_000);
  assert.equal(s.varies, false);
});

test('한 달만 있으면 아직 모른다', () => {
  assert.deepEqual(find([buy(9, 14, 17_000, '넷플릭스')]), []);
});

test('날짜는 밀리는 쪽으로만 흔들린다 — 가장 이른 날이 원래 날', () => {
  // 8/5 는 수요일, 9/7 은 월요일(9/5 가 토요일이라 밀림)
  const [s] = find([buy(8, 5, 55_000, 'SKT'), buy(9, 7, 55_000, 'SKT')]);
  assert.equal(s.dayOfMonth, 5, '자동이체는 앞당겨지지 않는다');
  assert.equal(s.spread, 2);
});

test('날짜가 제멋대로면 고정비가 아니다', () => {
  assert.deepEqual(find([buy(8, 3, 9_000, '배민'), buy(9, 22, 9_000, '배민')]), [],
    '한 달에 한 번 시켰다고 구독은 아니다');
});

test('금액이 달마다 바뀌어도 고정비다', () => {
  const [s] = find([buy(7, 8, 52_000, '통신요금'), buy(8, 8, 61_000, '통신요금'),
                    buy(9, 8, 58_000, '통신요금')]);
  assert.equal(s.varies, true, '통신비·전기요금을 빼면 안 된다');
  assert.equal(s.expectedAmount, 57_000, '평균으로 잡는다');
  assert.ok(s.confidence < 1, '금액이 흔들리면 덜 믿는다');
});

test('한 달에 여러 번 긁었으면 가장 이른 것만 본다', () => {
  const rows = [
    buy(8, 14, 17_000, '넷플릭스'),
    { ...buy(8, 27, 17_000, '넷플릭스'), id: 'x' },
    buy(9, 14, 17_000, '넷플릭스'),
  ];
  const [s] = find(rows);
  assert.equal(s.dayOfMonth, 14);
  assert.equal(s.months.length, 2, '같은 달을 두 번 세지 않는다');
});

test('이미 등록한 고정비는 다시 권하지 않는다', () => {
  const rows = [buy(8, 14, 17_000, '넷플릭스'), buy(9, 14, 17_000, '넷플릭스')];
  assert.deepEqual(find(rows, { recurring: [{ id: 'r1', name: '넷플릭스' }] }), []);
});

test('아니라고 한 것은 다시 안 묻는다', () => {
  const rows = [buy(8, 14, 17_000, '넷플릭스'), buy(9, 14, 17_000, '넷플릭스')];
  assert.deepEqual(find(rows, { settings: { ignoredRecurring: ['넷플릭스'] } }), []);
});

test('취소된 건은 세지 않는다', () => {
  const rows = [buy(8, 14, 17_000, '넷플릭스'),
                { ...buy(9, 14, 17_000, '넷플릭스'), status: 'voided' }];
  assert.deepEqual(find(rows), []);
});

test('큰 금액부터 보여 준다', () => {
  const rows = [
    buy(8, 14, 17_000, '넷플릭스'), buy(9, 14, 17_000, '넷플릭스'),
    buy(8, 8, 55_000, 'SKT'), buy(9, 8, 55_000, 'SKT'),
  ];
  assert.deepEqual(find(rows).map((s) => s.name), ['SKT', '넷플릭스']);
});

test('달이 많이 겹칠수록 더 믿는다', () => {
  const two = find([buy(8, 14, 17_000, '넷플릭스'), buy(9, 14, 17_000, '넷플릭스')])[0];
  const three = find([buy(7, 14, 17_000, '넷플릭스'), buy(8, 14, 17_000, '넷플릭스'),
                      buy(9, 14, 17_000, '넷플릭스')])[0];
  assert.ok(three.confidence > two.confidence);
});

test('달을 건너뛰었으면 그냥 가끔 가는 가게다', () => {
  // 6월 · 8월 · 9월에 비슷한 날짜에 긁었다고 구독은 아니다
  assert.deepEqual(find([buy(6, 12, 90_000, '쿠팡'), buy(8, 13, 95_000, '쿠팡')]), [],
    '7월이 비었다');
});

test('이어진 토막만 센다', () => {
  const [s] = find([
    buy(5, 14, 17_000, '넷플릭스'),      // 끊김
    buy(7, 14, 17_000, '넷플릭스'),
    buy(8, 14, 17_000, '넷플릭스'),
    buy(9, 14, 17_000, '넷플릭스'),
  ]);
  assert.deepEqual(s.months, ['2026-07', '2026-08', '2026-09']);
});

test('금액이 두 배 넘게 벌어지면 고정비가 아니다', () => {
  assert.deepEqual(find([buy(8, 13, 89_000, '쿠팡'), buy(9, 13, 210_000, '쿠팡')]), [],
    '쇼핑을 고정비로 잡으면 예산이 통째로 틀어진다');
  const [ok] = find([buy(7, 8, 52_000, '통신요금'), buy(8, 8, 61_000, '통신요금'),
                     buy(9, 8, 55_000, '통신요금')]);
  assert.equal(ok.varies, true, '통신비 정도는 고정비가 맞다');
});

test('금액이 흔들리면 더 지켜본다', () => {
  // 두 달, 금액이 다름 — 비슷한 날 두 번 쇼핑한 것과 구별이 안 된다
  assert.deepEqual(find([buy(8, 15, 132_000, '쿠팡'), buy(9, 13, 89_300, '쿠팡')]), []);
  // 세 달이면 믿는다
  const [s] = find([buy(7, 8, 52_000, '통신요금'), buy(8, 10, 61_000, '통신요금'),
                    buy(9, 8, 55_000, '통신요금')]);
  assert.equal(s.varies, true);
  assert.equal(s.months.length, 3);
});

test('같은 금액이면 두 달로 충분하다', () => {
  const [s] = find([buy(8, 14, 17_000, '넷플릭스'), buy(9, 14, 17_000, '넷플릭스')]);
  assert.equal(s.months.length, 2, '같은 금액이 두 달이면 구독이 맞다');
});
