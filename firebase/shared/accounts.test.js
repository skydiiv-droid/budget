import { test } from 'node:test';
import assert from 'node:assert/strict';
import { debtOf, cashOf, billingWindow, cardBills, rollup, rateOf, cardGroup }
  from './accounts.js';

const NOW = new Date(2026, 8, 19, 12, 0);   // 2026-09-19

test('마이너스통장은 입출금이면서 빚이다', () => {
  const minus = { type: 'checking', balance: -1_400_000, rate: 6.4 };
  assert.equal(debtOf(minus), 1_400_000, '음수 잔액의 절댓값이 빚이다');
  assert.equal(cashOf(minus), 0, '빚을 가진 돈으로 세면 안 된다');
});

test('잔액이 양수인 통장은 빚이 아니다', () => {
  const woori = { type: 'checking', balance: 812_400 };
  assert.equal(debtOf(woori), 0);
  assert.equal(cashOf(woori), 812_400);
});

test('리볼빙은 잔액이 양수인 채로 빚이다', () => {
  assert.equal(debtOf({ type: 'loan', balance: 2_180_000 }), 2_180_000);
  assert.equal(cashOf({ type: 'loan', balance: 2_180_000 }), 0);
});

test('카드는 가진 돈도 빚도 아니다', () => {
  const card = { type: 'card', cardType: 'credit', balance: 999 };
  assert.equal(cashOf(card), 0, '매달 쓰고 매달 내는 돈은 빚 목록에 올리지 않는다');
  assert.equal(debtOf(card), 0);
});

test('안 쓰는 계좌는 세지 않는다', () => {
  assert.equal(cashOf({ type: 'savings', balance: 500_000, active: false }), 0);
  assert.equal(debtOf({ type: 'loan', balance: 500_000, active: false }), 0);
});

test('청구 대상은 지난달 한 달 전체다', () => {
  const w = billingWindow(10, NOW);                 // 9/20, 결제일 10일
  assert.equal(w.from.getMonth(), 8, '9월 1일부터');
  assert.equal(w.to.getDate(), 30, '9월 30일까지');
  assert.equal(w.due.getMonth(), 9, '10월 10일에 낸다');
  assert.equal(w.month, '2026-09');
  assert.equal(w.open, true, '9월이 아직 안 끝나 청구액이 계속 는다');
});

test('결제일 전이면 이번 달 10일에 지난달치를 낸다', () => {
  const w = billingWindow(10, new Date(2026, 8, 5));   // 9/5
  assert.equal(w.month, '2026-08');
  assert.equal(w.due.getDate(), 10);
  assert.equal(w.due.getMonth(), 8, '9월 10일');
  assert.equal(w.open, false, '8월은 끝났으니 더 늘지 않는다');
});

test('기간 경계는 달력 날짜, 빠지는 날만 영업일로 미룬다', () => {
  const w = billingWindow(10, new Date(2026, 8, 20));
  assert.equal(w.due.getDate(), 10, '명세서는 10일에 닫힌다');
  assert.equal(w.payAt.getDate(), 12, '2026-10-10 은 토요일이라 12일 월요일');
});

test('미뤄졌는지 알려 준다', () => {
  const cards = [{ id: 'c1', name: '카드', type: 'card', cardType: 'credit', billingDay: 10 }];
  const [oct] = cardBills(cards, [], new Date(2026, 8, 20));
  assert.equal(oct.shifted, true, '2026-10-10 토요일');
  const [nov] = cardBills(cards, [], new Date(2026, 9, 20));
  assert.equal(nov.shifted, false, '2026-11-10 화요일');
});

const CARDS = [
  { id: 'c1', name: '현대 이마트Plus', type: 'card', cardType: 'credit', billingDay: 10,
    revolving: true, revolvingRatio: 100, revolvingRate: 19.9, revolvingBalance: 2_180_000 },
  { id: 'c2', name: '체크카드', type: 'card', cardType: 'debit', billingDay: 10 },
];
const TXNS = [
  { id: 't1', type: 'expense', amount: 30_000, occurredAt: '2026-09-15T10:00:00', accountId: 'c1' },
  { id: 't2', type: 'expense', amount: 20_000, occurredAt: '2026-09-02T10:00:00', accountId: 'c1' },
  { id: 't3', type: 'expense', amount: 99_000, occurredAt: '2026-08-05T10:00:00', accountId: 'c1' },
  { id: 't4', type: 'expense', amount: 11_000, occurredAt: '2026-09-15T10:00:00', accountId: 'c2' },
  { id: 't5', type: 'expense', amount: 50_000, occurredAt: '2026-09-15T10:00:00',
    accountId: 'c1', status: 'voided' },
];

test('체크카드는 청구가 생기지 않는다', () => {
  const bills = cardBills(CARDS, TXNS, NOW);
  assert.deepEqual(bills.map((b) => b.name), ['현대 이마트Plus'],
    '그 자리에서 빠지는 돈은 낼 게 없다');
});

test('다음 결제일에 낼 금액 = 그 달 사용분 + 넘어온 이월잔액', () => {
  const [bill] = cardBills(CARDS, TXNS, NOW);
  assert.equal(bill.usage, 50_000, '9월 한 달치 (8/5 건은 지난 청구에 들어갔다)');
  assert.equal(bill.carried, 2_180_000, '리볼빙으로 넘어온 것도 이번에 낼 돈이다');
  assert.equal(bill.billed, 2_230_000);
  assert.equal(bill.due.getMonth(), 9, '10월 10일');
});

test('취소된 건은 청구에 넣지 않는다', () => {
  const [bill] = cardBills(CARDS, TXNS, NOW);
  assert.equal(bill.usage, 50_000, '같은 날 50,000 취소분이 빠졌다');
});

test('카드 이름만 있는 옛 거래도 붙는다', () => {
  const old = [{ id: 'o1', type: 'expense', amount: 7_000,
                 occurredAt: '2026-09-15T10:00:00', cardName: '현대 이마트Plus' }];
  const [bill] = cardBills(CARDS, old, NOW);
  assert.equal(bill.usage, 7_000, 'accountId 가 붙기 전 거래를 버리면 안 된다');
});

// ───────────────────────────────────────────────── 카드 묶기

const PAIR = [
  { id: 'c1', name: '현대 이마트Plus', type: 'card', cardType: 'credit',
    billingDay: 10, statementGroupId: 'hd' },
  { id: 'c2', name: '현대 미래에셋', type: 'card', cardType: 'credit',
    billingDay: 10, statementGroupId: 'hd' },
];
const spent = (id, day, amount, accountId) => ({
  id, type: 'expense', amount, accountId,
  occurredAt: `2026-09-${String(day).padStart(2, '0')}T12:00:00`,
});

test('묶인 카드는 청구서 한 장으로 나온다', () => {
  const bills = cardBills(PAIR, [spent('a', 5, 100_000, 'c1'), spent('b', 6, 50_000, 'c2')], NOW);
  assert.equal(bills.length, 1, '현대카드는 누적을 합쳐 찍는다');
  assert.equal(bills[0].usage, 150_000);
  assert.deepEqual(bills[0].names, ['현대 이마트Plus', '현대 미래에셋']);
});

test('안 묶으면 따로 나온다', () => {
  const apart = PAIR.map((c) => ({ ...c, statementGroupId: '' }));
  assert.equal(cardBills(apart, [spent('a', 5, 100_000, 'c1')], NOW).length, 2);
});

// ───────────────────────────────────────────────── 리볼빙

test('리볼빙은 카드의 성질이지 따로 빌린 돈이 아니다', () => {
  const card = { id: 'c1', name: '현대', type: 'card', cardType: 'credit', billingDay: 10,
                 revolving: true, revolvingRatio: 30, revolvingRate: 19.9,
                 revolvingBalance: 1_000_000 };
  assert.equal(debtOf(card), 1_000_000, '이월된 것만 빚이다');
  const [bill] = cardBills([card], [spent('a', 5, 500_000, 'c1')], NOW);
  assert.equal(bill.billed, 1_500_000, '지난달 사용액 + 이월잔액');
  assert.equal(bill.total, 450_000, '그중 약정비율 30% 만 이번에 빠진다');
  assert.equal(bill.carryOut, 1_050_000, '나머지는 다음 달로');
  assert.ok(bill.interest > 0, '이월분에 이자가 붙는 걸 보여 줘야 한다');
});

test('리볼빙을 안 걸면 전액 빠진다', () => {
  const card = { id: 'c1', name: '현대', type: 'card', cardType: 'credit', billingDay: 10 };
  const [bill] = cardBills([card], [spent('a', 5, 500_000, 'c1')], NOW);
  assert.equal(bill.total, 500_000);
  assert.equal(bill.carryOut, 0);
  assert.equal(bill.revolving, false);
});

test('묶음에 리볼빙 카드가 하나라도 있으면 청구서 전체에 걸린다', () => {
  const pair = [{ ...PAIR[0], revolving: true, revolvingRatio: 50, revolvingRate: 19.9 }, PAIR[1]];
  const [bill] = cardBills(pair, [spent('a', 5, 100_000, 'c1'), spent('b', 6, 100_000, 'c2')], NOW);
  assert.equal(bill.ratio, 50);
  assert.equal(bill.total, 100_000, '청구서가 한 장이라 비율도 하나다');
});

test('마이너스통장은 플러스일 때와 이자율이 다르다', () => {
  assert.equal(rateOf({ type: 'checking', balance: -100, rate: 6.4, ratePlus: 0.1 }), 6.4);
  assert.equal(rateOf({ type: 'checking', balance: 100, rate: 6.4, ratePlus: 0.1 }), 0.1,
    '마통이라고 늘 마이너스인 건 아니다');
});

test('가진 돈과 빚이 한 번에 갈린다', () => {
  const all = [
    { id: 'a1', name: '우리은행', type: 'checking', balance: 812_400 },
    { id: 'a2', name: '마통', type: 'checking', balance: -1_400_000, rate: 6.4 },
    { id: 'a3', name: '청약', type: 'savings', balance: 1_240_000 },
    ...CARDS,
  ];
  const r = rollup(all, TXNS, NOW);
  assert.equal(r.cashTotal, 2_052_400);
  assert.equal(r.debtTotal, 3_580_000, '마통 140만 + 카드 이월 218만');
  assert.equal(r.debts[0].name, '현대 이마트Plus', '비싼 빚이 먼저 (연 19.9%)');
  assert.equal(r.billTotal, 2_230_000);
});
