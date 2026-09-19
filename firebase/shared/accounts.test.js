import { test } from 'node:test';
import assert from 'node:assert/strict';
import { debtOf, cashOf, billingWindow, cardBills, rollup } from './accounts.js';

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

test('결제일이 지났으면 그날부터 다음 결제일까지가 이번 청구다', () => {
  const w = billingWindow(10, NOW);                 // 9/19, 결제일 10일
  assert.equal(w.from.getMonth(), 8, '9월 10일이 기준점 — 그 전은 이미 냈다');
  assert.equal(w.due.getMonth(), 9, '10월 10일에 낸다');
});

test('결제일 전이면 이번 달 결제일이 마감이다', () => {
  const w = billingWindow(10, new Date(2026, 8, 5));   // 9/5
  assert.equal(w.due.getMonth(), 8);
  assert.equal(w.due.getDate(), 10);
});

const CARDS = [
  { id: 'c1', name: '현대 이마트Plus', type: 'card', cardType: 'credit', billingDay: 10 },
  { id: 'c2', name: '체크카드', type: 'card', cardType: 'debit', billingDay: 10 },
  { id: 'l1', name: '리볼빙', type: 'loan', balance: 2_180_000, rate: 19.9, linkedAccountId: 'c1' },
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
  assert.deepEqual(bills.map((b) => b.id), ['c1'], '그 자리에서 빠지는 돈은 낼 게 없다');
});

test('다음 결제일에 낼 금액 = 이번 기간 사용분 + 넘어온 리볼빙', () => {
  const [bill] = cardBills(CARDS, TXNS, NOW);
  assert.equal(bill.spent, 30_000, '9/10 이후 쓴 것만 — 9/2 건은 9/10 에 이미 냈다');
  assert.equal(bill.carried, 2_180_000, '리볼빙으로 넘어온 것도 이번에 낼 돈이다');
  assert.equal(bill.total, 2_210_000);
  assert.equal(bill.due.getMonth(), 9, '10월 10일');
});

test('취소된 건은 청구에 넣지 않는다', () => {
  const [bill] = cardBills(CARDS, TXNS, NOW);
  assert.equal(bill.spent, 30_000, '같은 날 50,000 취소분이 빠졌다');
});

test('카드 이름만 있는 옛 거래도 붙는다', () => {
  const old = [{ id: 'o1', type: 'expense', amount: 7_000,
                 occurredAt: '2026-09-15T10:00:00', cardName: '현대 이마트Plus' }];
  const [bill] = cardBills(CARDS, old, NOW);
  assert.equal(bill.spent, 7_000, 'accountId 가 붙기 전 거래를 버리면 안 된다');
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
  assert.equal(r.debtTotal, 3_580_000, '마통 140만 + 리볼빙 218만');
  assert.equal(r.debts[0].name, '리볼빙', '비싼 빚이 먼저');
  assert.equal(r.billTotal, 2_210_000);
});

test('기간 경계는 달력 날짜, 빠지는 날만 영업일로 미룬다', () => {
  // 2026-10-10 은 토요일
  const w = billingWindow(10, new Date(2026, 8, 20));
  assert.equal(w.due.getDate(), 10, '명세서는 10일에 닫힌다');
  assert.equal(w.payAt.getDate(), 12, '돈은 12일 월요일에 빠진다');
});

test('경계까지 같이 밀면 안 된다', () => {
  const w = billingWindow(10, new Date(2026, 8, 20));
  const onEleventh = new Date(2026, 9, 11);
  assert.ok(onEleventh > w.due,
    '11일에 쓴 것이 이미 닫힌 명세서로 들어가면 안 된다');
});

test('미뤄졌는지 알려 준다', () => {
  const cards = [{ id: 'c1', name: '카드', type: 'card', cardType: 'credit', billingDay: 10 }];
  const [oct] = cardBills(cards, [], new Date(2026, 8, 20));
  assert.equal(oct.shifted, true, '2026-10-10 토요일');
  const [nov] = cardBills(cards, [], new Date(2026, 9, 20));
  assert.equal(nov.shifted, false, '2026-11-10 화요일');
});

test('빚 목록의 금액은 늘 양수다', () => {
  const r = rollup([{ id: 'a', name: '마통', type: 'checking', balance: -1_400_000, rate: 6.4 }], [], NOW);
  assert.equal(r.debts[0].amount, 1_400_000, '화면에 -1,400,000 이 뜨면 안 된다');
  assert.equal(r.debts[0].balance, -1_400_000, '잔액 자체는 음수로 둬야 고칠 때 맞다');
});
