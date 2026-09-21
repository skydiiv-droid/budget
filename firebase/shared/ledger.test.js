import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowStart, hasOlderThan, WINDOW_MONTHS, paceShift,
         ledger, matchRecurring, monthSpending, breakdown, shiftMonth, monthWindow,
         sameSpanLastMonth, pace, trend, fixedDueIn, topSpending } from './ledger.js';

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
    accounts: [
      { id: 'a1', name: '마통', type: 'checking', balance: -3200000, rate: 6.8 },
      { id: 'a2', name: '리볼빙', type: 'loan', balance: 1840000, rate: 17.9 },
    ],
  });
  assert.equal(L.debt.items[0].name, '리볼빙', '비싼 빚부터 갚아야 총 이자가 적다');
  assert.equal(L.debt.total, 5040000, '마통은 음수 잔액의 절댓값이 빚이다');
  assert.equal(L.assets.total, 0, '마통이 마이너스면 가진 돈으로 세면 안 된다');
});

test('진행률은 시작 금액 대비로 센다', () => {
  const L = run({ accounts: [{ id: 'a1', name: '리볼빙', type: 'loan', balance: 5040000, rate: 17.9 }] },
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
  const L = run({ accounts: [{ id: 'a1', name: '리볼빙', type: 'loan', balance: 3000000, rate: 17.9 }] },
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
      { id: 'a3', name: '현대카드', type: 'card', cardType: 'credit', balance: 0 },
      { id: 'a4', name: '리볼빙', type: 'loan', balance: 1840000, rate: 17.9 },
    ],
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

test('지난달과 견줄 때는 같은 날짜까지만 본다', () => {
  const data = { settings: SETTINGS, transactions: [
    // 이번 달 19일까지
    { id: 'a', type: 'expense', amount: 50_000, occurredAt: '2026-09-04T10:00:00' },
    // 지난달 — 19일 전과 후
    { id: 'b', type: 'expense', amount: 30_000, occurredAt: '2026-08-04T10:00:00' },
    { id: 'c', type: 'expense', amount: 900_000, occurredAt: '2026-08-28T10:00:00' },
  ] };
  const prev = sameSpanLastMonth(data, '2026-09', NOW);   // 9/20 12:00
  assert.equal(prev.total, 30_000,
    '달 전체와 견주면 달 초엔 늘 덜 쓴 게 되고 말일에 뒤집힌다');
  assert.equal(prev.month, '2026-08');
  assert.equal(prev.whole, false);
});

test('달이 끝난 뒤엔 통째로 견준다', () => {
  const data = { settings: SETTINGS, transactions: [
    { id: 'c', type: 'expense', amount: 900_000, occurredAt: '2026-08-28T10:00:00' },
  ] };
  const prev = sameSpanLastMonth(data, '2026-09', new Date(2026, 9, 5));
  assert.equal(prev.whole, true);
  assert.equal(prev.total, 900_000);
});

test('이 속도면 이 달이 얼마가 되는지', () => {
  const p = pace(600_000, '2026-09', 1, new Date(2026, 8, 21));   // 20일 흘렀고 30일 달
  assert.equal(p.dayOf, 20);
  assert.equal(p.days, 30);
  assert.equal(p.projected, 900_000, '20일에 60만이면 30일엔 90만');
});

test('급여일 주기는 쉬는 날이면 앞당겨진다', () => {
  // 2026-07-05 는 일요일 → 7/3 금요일에 들어온다
  const plain = monthWindow('2026-07', 5);
  assert.equal(plain.start.getDate(), 5, '그냥 쓰면 달력 날짜 그대로');

  const paid = monthWindow('2026-07', 5, { payday: true });
  assert.equal(paid.start.getDate(), 3, '돈이 3일에 들어오면 주기도 3일부터');
  assert.equal(paid.end.getMonth(), 7, '다음 경계는 8월');
});

test('1일 시작은 옮길 것이 없다', () => {
  const w = monthWindow('2026-03', 1, { payday: true });
  assert.equal(w.start.getDate(), 1, '달력 월은 비교의 기준이라 흔들리면 안 된다');
});

// ───────────────────────────────────────────────── 목표

const goal = (g, extra = {}) => run({
  accounts: [{ id: 'a1', name: '리볼빙', type: 'loan', balance: 2_000_000, rate: 19.9 },
             { id: 'a2', name: '통장', type: 'savings', balance: 900_000 }, ...(extra.accounts || [])],
}, { goal: g, ...extra.settings }).goal;

test('갚기 목표는 시작 금액에서 0 으로 간다', () => {
  const g = goal({ kind: 'payoff', name: '빚 정리', startAmount: 4_000_000 });
  assert.equal(g.current, 2_000_000);
  assert.equal(g.moved, 2_000_000);
  assert.equal(g.pct, 50);
  assert.equal(g.remaining, 2_000_000);
});

test('모으기 목표는 0 에서 목표 금액으로 간다', () => {
  const g = goal({ kind: 'save', name: '비상금', startAmount: 0, targetAmount: 3_000_000 });
  assert.equal(g.current, 900_000, '가진 돈이 현재값');
  assert.equal(g.pct, 30);
  assert.equal(g.remaining, 2_100_000);
});

test('다 하면 끝난 걸로 표시한다', () => {
  const g = goal({ kind: 'save', startAmount: 0, targetAmount: 500_000 });
  assert.equal(g.done, true, '빚 다 갚으면 홈이 텅 비면 안 된다 — 다음 목표로 넘어갈 수 있어야 한다');
  assert.equal(g.pct, 100);
});

test('목표를 안 정했으면 지켜보기다', () => {
  const g = goal({ kind: 'keep' });
  assert.equal(g.pct, null);
  assert.equal(g.current, -1_100_000, '순자산을 보여 준다');
});

test('옛 빚 목표 설정을 그대로 읽는다', () => {
  const L = run({ accounts: [{ id: 'a1', name: '리볼빙', type: 'loan', balance: 2_000_000 }] },
                { debtStartAmount: 4_000_000, debtTargetDate: '2026-11-20' });
  assert.equal(L.goal.kind, 'payoff');
  assert.equal(L.goal.pct, 50);
  assert.ok(L.goal.daysToTarget > 0);
});

test('여력이 없으면 몇 달 걸리는지 말하지 않는다', () => {
  const g = goal({ kind: 'payoff', startAmount: 4_000_000 },
                 { settings: { monthlyIncome: 100_000, variableBudget: 500_000 } });
  assert.equal(g.paceMonths, null, '무한대는 답이 아니다');
});

// ───────────────────────────────────────────────── 갈래별 예산 · 추이

test('하위 칸에 쓴 돈은 큰 갈래 예산으로 접어 올린다', () => {
  const L = run({
    categories: CATS,
    transactions: [
      { id: 't1', type: 'expense', amount: 40_000, occurredAt: '2026-09-04T10:00:00', categoryId: 'cat_cafe' },
      { id: 't2', type: 'expense', amount: 60_000, occurredAt: '2026-09-05T10:00:00', categoryId: 'cat_delivery' },
    ],
  }, { categoryBudgets: { cat_food: 300_000 } });

  const food = L.byCategory.items.find((i) => i.id === 'cat_food');
  assert.equal(food.used, 100_000, '배달·외식·카페에 따로 잡으라면 아무도 안 잡는다');
  assert.equal(food.remaining, 200_000);
  assert.equal(food.pct, 33);
  assert.equal(food.over, false);
});

test('예산을 넘긴 갈래를 센다', () => {
  const L = run({
    categories: CATS,
    transactions: [
      { id: 't1', type: 'expense', amount: 400_000, occurredAt: '2026-09-04T10:00:00', categoryId: 'cat_cafe' },
    ],
  }, { categoryBudgets: { cat_food: 300_000 } });
  assert.equal(L.byCategory.overCount, 1);
  assert.equal(L.byCategory.items[0].over, true);
});

test('예산을 안 잡은 갈래는 넘길 수가 없다', () => {
  const L = run({
    categories: CATS,
    transactions: [
      { id: 't1', type: 'expense', amount: 900_000, occurredAt: '2026-09-04T10:00:00', categoryId: 'cat_transport' },
    ],
  });
  const t = L.byCategory.items.find((i) => i.id === 'cat_transport');
  assert.equal(t.used, 900_000);
  assert.equal(t.pct, null, '기준이 없으면 몇 %인지 말할 수 없다');
  assert.equal(L.byCategory.overCount, 0);
});

test('추이는 옛것부터 — 그래프는 왼쪽에서 오른쪽으로 읽는다', () => {
  const data = { settings: SETTINGS, transactions: [
    { id: 'a', type: 'expense', amount: 100_000, occurredAt: '2026-07-10T10:00:00' },
    { id: 'b', type: 'expense', amount: 200_000, occurredAt: '2026-08-10T10:00:00' },
    { id: 'c', type: 'expense', amount: 150_000, occurredAt: '2026-09-10T10:00:00' },
  ] };
  const t = trend(data, 3, NOW);          // 9/20
  assert.deepEqual(t.map((m) => m.month), ['2026-07', '2026-08', '2026-09']);
  assert.deepEqual(t.map((m) => m.total), [100_000, 200_000, 150_000]);
});

test('이번 달은 아직 안 끝났다고 말해 준다', () => {
  const data = { settings: SETTINGS, transactions: [
    { id: 'c', type: 'expense', amount: 150_000, occurredAt: '2026-09-10T10:00:00' },
  ] };
  const t = trend(data, 2, NOW);
  const last = t[t.length - 1];
  assert.equal(last.current, true);
  assert.ok(last.projected > last.total,
    '끝난 달과 나란히 두면 "이번 달은 적게 썼네"로 잘못 읽힌다');
  assert.equal(t[0].projected, t[0].total, '끝난 달은 끝값이 곧 합계다');
});

test('연 1회 고정비는 열두 달로 나눠 얹는다', () => {
  const L = run({ recurring: [
    { id: 'r1', name: '넷플릭스', expectedAmount: 17_000 },
    { id: 'r2', name: '자동차보험', expectedAmount: 600_000, period: 'yearly', monthOfYear: 3 },
  ] });
  assert.equal(L.planned.fixed, 17_000 + 50_000,
    '나가는 달에만 세면 나머지 열한 달은 여력이 있는 줄 안다');
});

test('이 달에 실제로 빠질 고정비만 따로 셀 수 있다', () => {
  const list = [
    { id: 'r1', name: '넷플릭스', expectedAmount: 17_000 },
    { id: 'r2', name: '자동차보험', expectedAmount: 600_000, period: 'yearly', monthOfYear: 3 },
  ];
  assert.deepEqual(fixedDueIn(list, '2026-09').map((r) => r.id), ['r1']);
  assert.deepEqual(fixedDueIn(list, '2026-03').map((r) => r.id), ['r1', 'r2']);
});

test('제일 많이 쓴 갈래 몇 개만 자른다', () => {
  const rows = monthSpending({ settings: SETTINGS, transactions: [
    { id: 'a', type: 'expense', amount: 40_000, occurredAt: '2026-09-04T10:00:00', categoryId: 'cat_cafe' },
    { id: 'b', type: 'expense', amount: 60_000, occurredAt: '2026-09-05T10:00:00', categoryId: 'cat_delivery' },
    { id: 'c', type: 'expense', amount: 30_000, occurredAt: '2026-09-06T10:00:00', categoryId: 'cat_transport' },
  ] }, '2026-09', NOW);

  const top = topSpending(rows, [...CATS, { id: 'cat_food', name: '식비', icon: '🍚', parentId: '' }], 2);
  assert.equal(top.length, 2);
  assert.equal(top[0].name, '식비');
  assert.equal(top[0].amount, 100_000, '하위까지 늘어놓으면 잔돈이 앞을 차지한다');
  assert.equal(top[0].pct, 77);
  assert.equal(top[1].name, '교통');
});

test('쓴 게 없으면 빈 목록이다', () => {
  assert.deepEqual(topSpending([], CATS, 3), []);
});

test('읽어 둘 창은 기본 화면이 쓰는 만큼이다', () => {
  // 그래프 여섯 달 · 탐지 넉 달 · 지난달 대비 두 달을 다 덮어야 한다
  assert.equal(windowStart(new Date('2026-09-21T10:00:00')), '2025-09-01T00:00:00');
  assert.equal(windowStart(new Date('2026-01-05T10:00:00')), '2025-01-01T00:00:00');
  // 달 경계를 넘을 때 하루라도 밀리면 그 달이 통째로 빈다
  assert.equal(windowStart(new Date('2026-03-01T00:00:01')), '2025-03-01T00:00:00');
  assert.equal(windowStart(new Date('2026-12-31T23:59:59')), '2025-12-01T00:00:00');
});

test('창은 늘릴 수 있고 한 달 밑으로는 안 내려간다', () => {
  assert.equal(windowStart(new Date('2026-09-21'), 2), '2026-08-01T00:00:00');
  assert.equal(windowStart(new Date('2026-09-21'), 1), '2026-09-01T00:00:00');
  assert.equal(windowStart(new Date('2026-09-21'), 0), '2026-09-01T00:00:00');
});

test('창보다 옛 것이 남아 있는지 안다', () => {
  const from = '2025-09-01T00:00:00';
  assert.equal(hasOlderThan('2025-08-31T23:00:00', from), true);
  assert.equal(hasOlderThan('2025-09-01T00:00:00', from), false);
  assert.equal(hasOlderThan('2026-01-02T00:00:00', from), false);
  // 창이 없다 = 다 읽어 왔다
  assert.equal(hasOlderThan('2020-01-01T00:00:00', ''), false);
  assert.equal(hasOlderThan('', from), false, '거래가 하나도 없으면 옛것도 없다');
});

test('아낀 만큼 목표가 당겨지는 날수를 센다', () => {
  // 남은 빚 300만, 달마다 100만씩 갚는 중 = 3개월.
  // 이번 달 20만을 덜 쓰면 120만 → 2.5개월. 그만큼 당겨진다.
  const s = paceShift(3_000_000, 1_000_000, 200_000);
  assert.equal(s.unlocks, false);
  assert.equal(s.stalls, false);
  assert.equal(s.days, Math.round((3 - 2.5) * 30.44));
  assert.equal(s.per, 1_200_000);
});

test('더 쓰면 밀린다 — 부호가 반대일 뿐이다', () => {
  const s = paceShift(3_000_000, 1_000_000, -200_000);
  assert.ok(s.days < 0, '밀리는 쪽은 음수다');
});

test('여력이 없다가 생기는 경우를 따로 알려 준다', () => {
  // 달마다 10만씩 모자라던 사람이 15만을 아끼면 비로소 갚기 시작한다
  const s = paceShift(3_000_000, -100_000, 150_000);
  assert.equal(s.unlocks, true);
  assert.equal(s.per, 50_000);
});

test('더 써서 갚을 여력이 사라지는 경우도 알려 준다', () => {
  const s = paceShift(3_000_000, 100_000, -150_000);
  assert.equal(s.stalls, true);
});

test('말할 것이 없으면 아무 말도 하지 않는다', () => {
  assert.equal(paceShift(3_000_000, 1_000_000, 0), null, '아낀 게 없다');
  assert.equal(paceShift(0, 1_000_000, 200_000), null, '갚을 것이 없다');
  assert.equal(paceShift(3_000_000, -100_000, -50_000), null, '원래도 못 갚고 있다');
  assert.equal(paceShift(3_000_000, 100_000_000, 10), null, '하루도 안 당겨지면 말하지 않는다');
});

test('달 초 며칠로 한 달을 점치지 않는다', () => {
  const at = (day) => pace(3_000, '2026-09', 1, new Date(`2026-09-${String(day).padStart(2, '0')}T09:00:00`));
  assert.equal(at(2).enough, false, '이틀치로는 말하지 않는다');
  assert.equal(at(9).enough, false);
  assert.equal(at(11).enough, true, '열흘이 지나면 말할 만하다');
  assert.equal(at(25).enough, true);
  // 숫자 자체는 늘 내준다. 말할지 말지는 보는 쪽이 정한다.
  assert.ok(at(2).projected > 0);
});

test('달이 시작도 안 했으면 아무것도 없다', () => {
  const r = pace(0, '2026-10', 1, new Date('2026-09-20T09:00:00'));
  assert.equal(r.enough, false);
  assert.equal(r.projected, 0);
});
