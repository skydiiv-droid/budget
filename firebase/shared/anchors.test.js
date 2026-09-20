import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardCheck, balanceCheck } from './anchors.js';

const CARD = { id: 'c1', name: '현대 이마트Plus', type: 'card', issuer: '현대카드' };
const buy = (day, amount, extra = {}) => ({
  id: `t${day}`, type: 'expense', amount, accountId: 'c1',
  occurredAt: `2026-09-${String(day).padStart(2, '0')}T12:00:00`, ...extra,
});
const anchor = (at, reported, extra = {}) => ({
  kind: 'cumulative', at, reported, cardName: '현대 이마트Plus', issuer: '현대카드', ...extra,
});

test('카드사가 센 것과 우리가 센 것이 같으면 통과', () => {
  const [r] = cardCheck({
    anchors: [anchor('2026-09-19T19:14:00', 30_000)],
    transactions: [buy(5, 10_000), buy(12, 20_000)],
    accounts: [CARD],
  });
  assert.equal(r.counted, 30_000);
  assert.equal(r.gap, 0);
  assert.equal(r.ok, true);
});

test('빠진 만큼을 금액으로 말해 준다', () => {
  const [r] = cardCheck({
    anchors: [anchor('2026-09-19T19:14:00', 3_634_067)],
    transactions: [buy(5, 3_601_167)],
    accounts: [CARD],
  });
  assert.equal(r.missing, 32_900, '놓친 걸 놓친 줄 모르는 게 제일 나쁘다');
  assert.equal(r.ok, false);
});

test('앵커보다 늦게 쓴 건 세지 않는다', () => {
  const [r] = cardCheck({
    anchors: [anchor('2026-09-10T12:00:00', 10_000)],
    transactions: [buy(5, 10_000), buy(20, 99_000)],
    accounts: [CARD],
  });
  assert.equal(r.counted, 10_000, '누적은 찍힌 그 시각까지의 합이다');
  assert.equal(r.ok, true);
});

test('누적은 달력 월 기준이다 — 지난달 건은 안 센다', () => {
  const [r] = cardCheck({
    anchors: [anchor('2026-09-19T12:00:00', 10_000)],
    transactions: [buy(5, 10_000),
                   { ...buy(28, 500_000), occurredAt: '2026-08-28T12:00:00' }],
    accounts: [CARD],
  });
  assert.equal(r.counted, 10_000);
});

test('취소된 건은 카드사 누적에서도 빠진다', () => {
  const [r] = cardCheck({
    anchors: [anchor('2026-09-19T12:00:00', 10_000)],
    transactions: [buy(5, 10_000), buy(6, 50_000, { status: 'voided' })],
    accounts: [CARD],
  });
  assert.equal(r.ok, true);
});

test('카드마다 가장 최근 누적만 본다', () => {
  const [r] = cardCheck({
    anchors: [anchor('2026-09-05T12:00:00', 10_000), anchor('2026-09-19T12:00:00', 30_000)],
    transactions: [buy(5, 10_000), buy(12, 20_000)],
    accounts: [CARD],
  });
  assert.equal(r.reported, 30_000, '옛 앵커는 이미 지나간 얘기다');
});

test('카드 둘을 섞지 않는다', () => {
  const other = { id: 'c2', name: '현대 미래에셋', type: 'card', issuer: '현대카드' };
  const rows = cardCheck({
    anchors: [anchor('2026-09-19T12:00:00', 30_000),
              anchor('2026-09-19T12:00:00', 5_000, { cardName: '현대 미래에셋' })],
    transactions: [buy(5, 30_000), { ...buy(6, 5_000), accountId: 'c2' }],
    accounts: [CARD, other],
  });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.ok), '한 카드 것이 다른 카드로 새면 둘 다 틀린다');
});

test('어긋난 게 큰 것부터 보여 준다', () => {
  const other = { id: 'c2', name: '현대 미래에셋', type: 'card', issuer: '현대카드' };
  const rows = cardCheck({
    anchors: [anchor('2026-09-19T12:00:00', 31_000),
              anchor('2026-09-19T12:00:00', 99_000, { cardName: '현대 미래에셋' })],
    transactions: [buy(5, 30_000), { ...buy(6, 5_000), accountId: 'c2' }],
    accounts: [CARD, other],
  });
  assert.equal(rows[0].name, '현대 미래에셋');
});

// ───────────────────────────────────────────────── 통장 잔액

const WOORI = { id: 'a1', name: '우리은행', type: 'checking', issuer: '우리은행',
                balance: 800_000, balanceAt: '2026-09-01T00:00:00' };
const bal = (at, reported) =>
  ({ kind: 'balance', at, reported, issuer: '우리은행', cardName: '' });

test('문자에 찍힌 잔액이 정답이다', () => {
  const [r] = balanceCheck({ anchors: [bal('2026-09-19T20:02:00', 812_400)], accounts: [WOORI] });
  assert.equal(r.reported, 812_400);
  assert.equal(r.held, 800_000);
  assert.equal(r.gap, 12_400);
  assert.equal(r.stale, true, '계좌에 적힌 게 문자보다 오래됐다');
});

test('이미 맞춰 놨으면 갈아 끼울 게 없다', () => {
  const fresh = { ...WOORI, balance: 812_400, balanceAt: '2026-09-19T20:02:00' };
  const [r] = balanceCheck({ anchors: [bal('2026-09-19T20:02:00', 812_400)], accounts: [fresh] });
  assert.equal(r.ok, true);
  assert.equal(r.stale, false);
});

test('붙일 계좌가 없으면 말이 없다', () => {
  assert.deepEqual(balanceCheck({ anchors: [bal('2026-09-19T20:02:00', 1)], accounts: [] }), []);
});
