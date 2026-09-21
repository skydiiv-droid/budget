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

// ───────────────────────────────────────────────── 카드 묶음

const PAIR = [
  { id: 'c1', name: '현대 이마트Plus', type: 'card', cardType: 'credit',
    issuer: '현대카드', statementGroupId: 'hd', active: true },
  { id: 'c2', name: '현대 미래에셋', type: 'card', cardType: 'credit',
    issuer: '현대카드', statementGroupId: 'hd', active: true },
];

test('누적은 카드 한 장이 아니라 청구서 한 장 기준이다', () => {
  // 미래에셋 10만 + 이마트 5만 + 미래에셋 1만 = 누적 16만
  const [r] = cardCheck({
    anchors: [anchor('2026-09-19T12:00:00', 160_000)],
    transactions: [
      { ...buy(5, 100_000), accountId: 'c2' },
      { ...buy(6, 50_000), accountId: 'c1' },
      { ...buy(7, 10_000), accountId: 'c2' },
    ],
    accounts: PAIR,
  });
  assert.equal(r.counted, 160_000, '카드 하나로만 견주면 영영 안 맞는다');
  assert.equal(r.ok, true);
  assert.equal(r.name, '현대 이마트Plus + 현대 미래에셋');
});

test('안 묶인 카드는 따로 견준다', () => {
  const apart = PAIR.map((c) => ({ ...c, statementGroupId: '' }));
  const [r] = cardCheck({
    anchors: [anchor('2026-09-19T12:00:00', 160_000)],
    transactions: [{ ...buy(5, 100_000), accountId: 'c2' },
                   { ...buy(6, 50_000), accountId: 'c1' }],
    accounts: apart,
  });
  assert.equal(r.counted, 50_000, '이마트 것만 센다');
  assert.equal(r.missing, 110_000);
});

test('손으로 넣은 거래도 함께 센다', () => {
  const [r] = cardCheck({
    anchors: [anchor('2026-09-19T12:00:00', 60_000)],
    transactions: [
      { ...buy(5, 50_000), accountId: 'c1' },
      { ...buy(6, 10_000), accountId: 'c2', source: 'manual' },
    ],
    accounts: PAIR,
  });
  assert.equal(r.ok, true, '내역에서 넣은 건이 대조에 안 잡히면 영영 안 맞는다');
});

test('리볼빙 이월잔액을 놓친 결제로 세지 않는다', () => {
  const accounts = [{
    id: 'c1', type: 'card', cardType: 'credit', name: '현대 미래에셋', issuer: '현대',
    revolving: true, revolvingBalance: 1_200_000, revolvingRatio: 70,
  }];
  const transactions = [
    { id: 't1', type: 'expense', amount: 300_000, occurredAt: '2026-09-10T10:00:00', accountId: 'c1' },
  ];
  const anchors = [{
    kind: 'cumulative', cardName: '현대 미래에셋', issuer: '현대',
    reported: 1_500_000, at: '2026-09-10T10:01:00',
  }];

  const [row] = cardCheck({ anchors, transactions, accounts });
  assert.equal(row.carried, 1_200_000);
  assert.equal(row.gap, 0);
  assert.equal(row.missing, 0);
  assert.equal(row.ok, true);
});

test('이월잔액을 빼서 더 벌어지면 손대지 않는다', () => {
  // 누적에 이월분을 안 얹는 카드사. 빼 버리면 없던 차이가 생긴다.
  const accounts = [{
    id: 'c1', type: 'card', cardType: 'credit', name: '현대 미래에셋', issuer: '현대',
    revolving: true, revolvingBalance: 1_200_000, revolvingRatio: 70,
  }];
  const transactions = [
    { id: 't1', type: 'expense', amount: 300_000, occurredAt: '2026-09-10T10:00:00', accountId: 'c1' },
  ];
  const anchors = [{
    kind: 'cumulative', cardName: '현대 미래에셋', issuer: '현대',
    reported: 310_000, at: '2026-09-10T10:01:00',
  }];

  const [row] = cardCheck({ anchors, transactions, accounts });
  assert.equal(row.carried, 0);
  assert.equal(row.missing, 10_000);
});

test('리볼빙을 안 쓰는 카드는 그대로 견준다', () => {
  const accounts = [{ id: 'c1', type: 'card', cardType: 'credit', name: '현대 이마트', issuer: '현대' }];
  const transactions = [
    { id: 't1', type: 'expense', amount: 300_000, occurredAt: '2026-09-10T10:00:00', accountId: 'c1' },
  ];
  const anchors = [{
    kind: 'cumulative', cardName: '현대 이마트', issuer: '현대',
    reported: 332_900, at: '2026-09-10T10:01:00',
  }];

  const [row] = cardCheck({ anchors, transactions, accounts });
  assert.equal(row.carried, 0);
  assert.equal(row.missing, 32_900);
});

// ── 언제부터 어긋났나 ────────────────────────────────────
const HD = [{ id: 'c1', type: 'card', cardType: 'credit', name: '현대 미래에셋', issuer: '현대', active: true }];
const swipe = (id, amount, at) => ({ id, type: 'expense', amount, occurredAt: at, accountId: 'c1' });
const ping = (reported, at) => ({ kind: 'cumulative', cardName: '현대 미래에셋', issuer: '현대', reported, at });

test('맞았던 마지막 문자와 처음 틀어진 문자를 짚어 준다', () => {
  // 9/17 까진 맞다가 9/18 에 32,900 짜리 하나를 놓쳤다
  const transactions = [
    swipe('t1', 100_000, '2026-09-10T10:00:00'),
    swipe('t2', 423_350, '2026-09-17T14:00:00'),
    swipe('t3', 5_800, '2026-09-19T11:00:00'),
  ];
  const anchors = [
    ping(100_000, '2026-09-10T10:01:00'),
    ping(523_350, '2026-09-17T14:20:00'),
    ping(556_250, '2026-09-18T10:20:00'),
    ping(562_050, '2026-09-19T11:01:00'),
  ];
  const [row] = cardCheck({ anchors, transactions, accounts: HD });

  assert.equal(row.lastOk.at, '2026-09-17T14:20:00', '여기까진 맞았다');
  assert.equal(row.lastOk.reported, 523_350);
  assert.equal(row.since.at, '2026-09-18T10:20:00', '여기서 틀어졌다');
  assert.equal(row.since.reported, 556_250);
  assert.equal(row.since.counted, 523_350);
  assert.equal(row.since.gap, 32_900, '그 사이에 빠진 금액');
  assert.equal(row.window, 0, '두 문자가 바로 붙어 있다');
});

test('사이에 낀 문자가 있으면 몇 통인지 센다', () => {
  // 맞은 문자와 틀어진 문자 사이에 다른 문자가 껴 있으면 볼 구간이 넓다.
  // 여기서는 9/12 에 틀어지고 9/13·9/14 도 계속 틀어진 상태로 온다.
  const transactions = [swipe('t1', 10_000, '2026-09-10T10:00:00')];
  const anchors = [
    ping(10_000, '2026-09-10T10:01:00'),
    ping(50_000, '2026-09-12T10:00:00'),
    ping(60_000, '2026-09-13T10:00:00'),
    ping(70_000, '2026-09-14T10:00:00'),
  ];
  const [row] = cardCheck({ anchors, transactions, accounts: HD });
  assert.equal(row.lastOk.at, '2026-09-10T10:01:00');
  assert.equal(row.since.at, '2026-09-12T10:00:00', '처음 틀어진 곳을 짚는다');
  assert.equal(row.window, 0);
});

test('맞은 적이 없으면 맞았던 곳을 지어내지 않는다', () => {
  const anchors = [ping(50_000, '2026-09-12T10:00:00')];
  const [row] = cardCheck({ anchors, transactions: [], accounts: HD });
  assert.equal(row.lastOk, null);
  assert.equal(row.since.at, '2026-09-12T10:00:00');
});

test('다시 맞아지면 그 뒤부터 새로 센다', () => {
  // 중간에 틀어졌다가 문자를 채워 넣어 맞아졌고, 그 뒤에 또 틀어졌다.
  // 짚어 줄 곳은 **나중** 것이다 — 앞엣것은 이미 해결됐다.
  const transactions = [
    swipe('t1', 10_000, '2026-09-10T10:00:00'),
    swipe('t2', 40_000, '2026-09-11T10:00:00'),
  ];
  const anchors = [
    ping(10_000, '2026-09-10T10:01:00'),
    ping(50_000, '2026-09-11T10:01:00'),
    ping(90_000, '2026-09-15T10:00:00'),
  ];
  const [row] = cardCheck({ anchors, transactions, accounts: HD });
  assert.equal(row.lastOk.at, '2026-09-11T10:01:00');
  assert.equal(row.since.at, '2026-09-15T10:00:00');
});

test('다 맞으면 짚을 곳이 없다', () => {
  const transactions = [swipe('t1', 10_000, '2026-09-10T10:00:00')];
  const anchors = [ping(10_000, '2026-09-10T10:01:00')];
  const [row] = cardCheck({ anchors, transactions, accounts: HD });
  assert.equal(row.ok, true);
  assert.equal(row.since, null);
});

test('리볼빙 이월분은 짚는 데에도 똑같이 빼 준다', () => {
  const accounts = [{ ...HD[0], revolving: true, revolvingBalance: 1_000_000, revolvingRatio: 70 }];
  const transactions = [swipe('t1', 10_000, '2026-09-10T10:00:00')];
  const anchors = [
    ping(1_010_000, '2026-09-10T10:01:00'),      // 이월분 포함 — 맞은 것이다
    ping(1_050_000, '2026-09-12T10:00:00'),      // 40,000 이 빈다
  ];
  const [row] = cardCheck({ anchors, transactions, accounts });
  assert.equal(row.carried, 1_000_000);
  assert.equal(row.lastOk.at, '2026-09-10T10:01:00');
  assert.equal(row.since.gap, 40_000);
});
