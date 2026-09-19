import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ledger, matchRecurring, monthSpending, breakdown, shiftMonth } from './ledger.js';

const NOW = new Date(2026, 8, 20, 12, 0);   // 2026-09-20
const SETTINGS = { monthlyIncome: 2800000, variableBudget: 1300000, cycleStartDay: 1 };
const run = (data, settings = {}) =>
  ledger({ ...data, settings: { ...SETTINGS, ...settings } }, '2026-09', NOW);

test('갚을 여력 = 수입 − 고정 − 변동 예산', () => {
  const L = run({ recurring: [{ id: 'r1', name: '넷플릭스', expectedAmount: 17000 }] });
  assert.equal(L.planned.fixed, 17000);
  assert.equal(L.planned.available, 2800000 - 17000 - 1300000);
});

test('고정지출로 등록한 가게의 결제는 변동지출에서 빠진다', () => {
  const L = run({
    recurring: [{ id: 'r1', name: '넷플릭스', expectedAmount: 17000 }],
    transactions: [
      { id: 't1', type: 'expense', amount: 17000, occurredAt: '2026-09-05T00:00:00', merchantRaw: '넷플릭스' },
      { id: 't2', type: 'expense', amount: 5000, occurredAt: '2026-09-06T00:00:00', merchantRaw: '컴포즈커피' },
    ],
  });
  assert.equal(L.actual.fixed, 17000, '구독은 등록 항목이자 카드 결제이기도 하다');
  assert.equal(L.actual.variable, 5000, '두 번 세면 안 된다');
});

test('이체는 지출로 세지 않는다', () => {
  const L = run({
    transactions: [{ id: 't1', type: 'transfer', amount: 430000,
                     occurredAt: '2026-09-05T00:00:00', merchantRaw: '현대카드' }],
  });
  assert.equal(L.actual.variable, 0,
    '카드대금을 지출로 잡으면 매달 카드값만큼 부풀어 오른다');
});

test('더치페이로 돌려받은 만큼은 내 지출이 아니다', () => {
  const L = run({
    transactions: [{ id: 't1', type: 'expense', amount: 93800,
                     occurredAt: '2026-09-14T00:00:00', merchantRaw: '고깃집', settlementId: 's1' }],
    settlements: [{ id: 's1', txnId: 't1', receivedAmount: 70350 }],
  });
  assert.equal(L.actual.variable, 23450);
});

test('지난달 거래는 이번 달에 안 들어온다', () => {
  const L = run({
    transactions: [{ id: 't1', type: 'expense', amount: 50000,
                     occurredAt: '2026-08-31T23:00:00', merchantRaw: '지난달' }],
  });
  assert.equal(L.actual.variable, 0);
});

test('빚은 이자율이 높은 것이 앞에 온다', () => {
  const L = run({
    debts: [
      { id: 'd1', name: '마통', balance: 3200000, rate: 6.8 },
      { id: 'd2', name: '리볼빙', balance: 1840000, rate: 17.9 },
    ],
  });
  assert.equal(L.debt.items[0].name, '리볼빙', '비싼 빚부터 갚아야 총 이자가 적다');
  assert.equal(L.debt.total, 5040000);
});

test('진행률은 시작 금액 대비로 센다', () => {
  const L = run({ debts: [{ id: 'd1', name: '리볼빙', balance: 5040000, rate: 17.9 }] },
                { debtStartAmount: 7000000 });
  assert.equal(L.debt.paid, 1960000);
  assert.equal(L.debt.progressPct, 28);
});

test('여력이 없으면 몇 달 걸리는지 답하지 않는다', () => {
  const L = run({ debts: [{ id: 'd1', name: '마통', balance: 3000000, rate: 6.8 }] },
                { monthlyIncome: 0 });
  assert.equal(L.debt.paceMonths, null, '0으로 나눈 무한대를 보여 주면 안 된다');
});

test('목표일이 있으면 필요한 월 상환액과 부족분을 낸다', () => {
  const L = run({ debts: [{ id: 'd1', name: '리볼빙', balance: 3000000, rate: 17.9 }] },
                { debtTargetDate: '2026-11-20' });
  assert.ok(L.debt.needPerMonth > 0);
  assert.equal(typeof L.debt.onTrack, 'boolean');
  assert.equal(L.debt.shortfall, Math.max(0, L.debt.needPerMonth - L.planned.available));
});

test('순자산 = 가진 돈 − 빚, 카드는 가진 돈이 아니다', () => {
  const L = run({
    accounts: [
      { id: 'a1', name: '우리은행', type: 'checking', balance: 500000 },
      { id: 'a2', name: '적금', type: 'savings', balance: 1200000 },
      { id: 'a3', name: '현대카드', type: 'card', balance: 0 },
    ],
    debts: [{ id: 'd1', name: '리볼빙', balance: 1840000, rate: 17.9 }],
  });
  assert.equal(L.assets.total, 1700000);
  assert.equal(L.assets.net, -140000, '빚이 더 크면 순자산은 음수다');
});

test('손이 필요한 것을 센다', () => {
  const L = run({
    transactions: [{ id: 't1', status: 'pendingCategory', type: 'expense', amount: 1,
                     occurredAt: '2026-09-20T00:00:00' }],
    raw: [{ id: 'r1', parsedOk: false, txnId: null },
          { id: 'r2', parsedOk: false, txnId: 't9' }],
  });
  assert.equal(L.inbox.pending, 1);
  assert.equal(L.inbox.unparsed, 1, '이미 거래가 달린 문자는 할 일이 아니다');
});

test('이름이 가맹점에 들어 있으면 같은 고정지출로 본다', () => {
  const rules = [{ id: 'r1', name: '넷플릭스' }];
  assert.ok(matchRecurring({ merchantRaw: '넷플릭스닷컴' }, rules));
  assert.equal(matchRecurring({ merchantRaw: '컴포즈커피' }, rules), null);
});

// ───────────────────────────────────────────────── 내역

const CATS = [
  { id: 'cat_food', name: '식비', parentId: '' },
  { id: 'cat_cafe', name: '카페', parentId: 'cat_food' },
  { id: 'cat_delivery', name: '배달', parentId: 'cat_food' },
  { id: 'cat_transport', name: '교통', parentId: '' },
];

const spend = (data) => monthSpending({ ...data, settings: SETTINGS }, '2026-09', NOW);

test('달을 앞뒤로 옮기면 해가 넘어가도 맞는다', () => {
  assert.equal(shiftMonth('2026-09', 1), '2026-10');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
});

test('그 달 지출만, 최근 것부터', () => {
  const rows = spend({ transactions: [
    { id: 't1', type: 'expense', amount: 1000, occurredAt: '2026-09-03T10:00:00' },
    { id: 't2', type: 'expense', amount: 2000, occurredAt: '2026-09-18T10:00:00' },
    { id: 't3', type: 'expense', amount: 3000, occurredAt: '2026-08-31T10:00:00' },
    { id: 't4', type: 'transfer', amount: 4000, occurredAt: '2026-09-10T10:00:00' },
    { id: 't5', type: 'expense', amount: 5000, occurredAt: '2026-09-11T10:00:00', status: 'voided' },
  ] });
  assert.deepEqual(rows.map((r) => r.id), ['t2', 't1']);
});

test('예산에서 뺀 건은 목록에 남기되 세지 않는다', () => {
  const rows = spend({ transactions: [
    { id: 't1', type: 'expense', amount: 9000, occurredAt: '2026-09-04T10:00:00', excludeFromBudget: true },
  ] });
  assert.equal(rows.length, 1, '안 보이면 왜 합계가 다른지 알 길이 없다');
  assert.equal(rows[0].counted, false);
  assert.equal(breakdown(rows, CATS).total, 0);
});

test('하위 칸의 돈은 큰 갈래로 접어 올린다', () => {
  const rows = spend({ transactions: [
    { id: 't1', type: 'expense', amount: 4000, occurredAt: '2026-09-04T10:00:00', categoryId: 'cat_cafe' },
    { id: 't2', type: 'expense', amount: 8000, occurredAt: '2026-09-05T10:00:00', categoryId: 'cat_delivery' },
    { id: 't3', type: 'expense', amount: 8000, occurredAt: '2026-09-06T10:00:00', categoryId: 'cat_transport' },
  ] });
  const b = breakdown(rows, CATS);

  assert.equal(b.total, 20000);
  assert.deepEqual(b.items.map((i) => [i.id, i.amount, i.pct]),
    [['cat_food', 12000, 60], ['cat_transport', 8000, 40]]);
  assert.deepEqual(b.items[0].subs.map((s) => [s.id, s.amount]),
    [['cat_delivery', 8000], ['cat_cafe', 4000]], '큰 쪽이 먼저');
  assert.deepEqual(b.items[1].subs, [], '갈래가 하나뿐이면 쪼개지 않는다');
});

test('카테고리를 안 고른 건은 미분류로 모인다', () => {
  const rows = spend({ transactions: [
    { id: 't1', type: 'expense', amount: 3000, occurredAt: '2026-09-04T10:00:00' },
  ] });
  assert.equal(breakdown(rows, CATS).items[0].id, 'cat_unknown');
});
