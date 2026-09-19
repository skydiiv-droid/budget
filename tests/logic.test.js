/** 정산(더치페이) 금액 계산과 위치 매칭 테스트. */
const assert = require('assert');
const { load, plain } = require('./harness');
const { createStore } = require('./store');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL ' + name + '\n       ' + err.message);
  }
}

function withStore(initial) {
  const store = createStore(initial);
  const ctx = load(['Config.gs', 'Util.gs', 'Settlement.gs', 'Classify.gs'], store);
  return { ctx, store };
}

console.log('\n더치페이 정산');

check('인원수를 주면 내 몫을 뺀 나머지를 회수 예상액으로 잡는다', () => {
  const { ctx } = withStore({
    Transaction: [{ id: 'txn1', amount: 93800, settlementId: '' }],
  });
  const r = ctx.openSettlement({ txnId: 'txn1', headcount: 4 });
  assert.strictEqual(r.myShare, 23450);
  assert.strictEqual(r.expectedAmount, 70350, '4명이면 나 뺀 3명 몫을 받는다');
});

check('보낸 금액이 제각각이어도 오차 안이면 정산이 닫힌다', () => {
  const { ctx } = withStore({
    Transaction: [
      { id: 'txn1', amount: 93800, settlementId: '' },
      { id: 'in1', amount: 23450, type: 'income' },
      { id: 'in2', amount: 23500, type: 'income' },   // 50원 더
      { id: 'in3', amount: 24000, type: 'income' },   // 550원 더
    ],
  });
  const s = ctx.openSettlement({ txnId: 'txn1', headcount: 4 });
  ctx.linkSettlement({ settlementId: s.settlementId, incomeTxnId: 'in1' });
  ctx.linkSettlement({ settlementId: s.settlementId, incomeTxnId: 'in2' });
  const r = ctx.linkSettlement({ settlementId: s.settlementId, incomeTxnId: 'in3' });

  assert.strictEqual(r.receivedAmount, 70950);
  assert.strictEqual(r.remaining, -600, '600원 더 받았다');
  assert.strictEqual(r.settled, true, '허용 오차(3,518원) 안이므로 닫혀야 한다');
});

check('한 명이 안 보내면 열린 채로 남는다', () => {
  const { ctx } = withStore({
    Transaction: [
      { id: 'txn1', amount: 93800, settlementId: '' },
      { id: 'in1', amount: 23450, type: 'income' },
      { id: 'in2', amount: 23450, type: 'income' },
    ],
  });
  const s = ctx.openSettlement({ txnId: 'txn1', headcount: 4 });
  ctx.linkSettlement({ settlementId: s.settlementId, incomeTxnId: 'in1' });
  const r = ctx.linkSettlement({ settlementId: s.settlementId, incomeTxnId: 'in2' });

  assert.strictEqual(r.remaining, 23450);
  assert.strictEqual(r.settled, false);
});

check('통계에 잡히는 금액은 총액이 아니라 내 순부담이다', () => {
  const { ctx, store } = withStore({
    Transaction: [{ id: 'txn1', amount: 93800, settlementId: '' },
                  { id: 'in1', amount: 70350, type: 'income' }],
  });
  const s = ctx.openSettlement({ txnId: 'txn1', headcount: 4 });
  ctx.linkSettlement({ settlementId: s.settlementId, incomeTxnId: 'in1' });

  const txn = store.findBy_('Transaction', 'id', 'txn1');
  assert.strictEqual(ctx.netAmountOf_(txn), 23450, '9만 쓰고 7만 받았으면 내 돈은 2만이다');
});

check('회수 입금은 수입 합계에서 빠진다', () => {
  const { ctx, store } = withStore({
    Transaction: [{ id: 'txn1', amount: 93800, settlementId: '' },
                  { id: 'in1', amount: 70350, type: 'income' }],
  });
  const s = ctx.openSettlement({ txnId: 'txn1', headcount: 4 });
  ctx.linkSettlement({ settlementId: s.settlementId, incomeTxnId: 'in1' });

  const income = store.findBy_('Transaction', 'id', 'in1');
  assert.strictEqual(income.categoryId, 'cat_settle_in');
  assert.strictEqual(income.excludeFromBudget, true, '돌려받은 돈은 급여와 같이 세면 안 된다');
});

check('입금액에 가까운 열린 정산을 후보로 올린다', () => {
  const { ctx } = withStore({
    Transaction: [{ id: 'txn1', amount: 93800, merchantRaw: '고깃집', occurredAt: '2026-09-15T20:00:00' }],
  });
  const s = ctx.openSettlement({ txnId: 'txn1', headcount: 4 });
  const candidates = ctx.suggestSettlements_(23500);
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].settlementId, s.settlementId);
});

check('남은 금액보다 크게 들어온 입금은 후보에서 뺀다', () => {
  const { ctx } = withStore({
    Transaction: [{ id: 'txn1', amount: 40000, merchantRaw: '카페', occurredAt: '2026-09-15T20:00:00' }],
  });
  ctx.openSettlement({ txnId: 'txn1', headcount: 2 });   // 회수 예상 20,000
  assert.strictEqual(ctx.suggestSettlements_(2800000).length, 0, '급여 입금이 정산 후보로 뜨면 안 된다');
});

console.log('\n기본 분류 규칙');

function seeded() {
  const store = createStore({});
  const ctx = load(['Config.gs', 'Util.gs', 'Classify.gs', 'Seed.gs'], store);
  ctx.seedRules_();
  ctx.seedMerchants_();
  return ctx;
}

check('실물 가맹점 "컴포즈커피발산"을 카페로 분류한다', () => {
  assert.strictEqual(seeded().classify_('컴포즈커피발산', 1800, null).categoryId, 'cat_cafe');
});

check('이마트24는 마트가 아니라 편의점이다', () => {
  const r = seeded().classify_('이마트24 역삼점', 3000, null);
  assert.strictEqual(r.categoryId, 'cat_convenience', '"이마트"에 먼저 걸리면 안 된다');
});

check('쿠팡이츠는 쇼핑이 아니라 배달이다', () => {
  const r = seeded().classify_('쿠팡이츠', 18000, null);
  assert.strictEqual(r.categoryId, 'cat_delivery', '"쿠팡"에 먼저 걸리면 안 된다');
});

check('구독은 디지털과 미디어로 갈린다', () => {
  const ctx = seeded();
  assert.strictEqual(ctx.classify_('ANTHROPIC CLAUDE', 30000, null).categoryId, 'cat_sub_digital');
  assert.strictEqual(ctx.classify_('NETFLIX.COM', 17000, null).categoryId, 'cat_sub_media');
});

check('간편결제 대행사는 이름으로 분류하지 않는다', () => {
  const r = seeded().classify_('네이버파이낸셜', 12000, null);
  assert.strictEqual(r.categoryId, null);
  assert.strictEqual(r.reason, 'passthrough', '무엇을 샀는지 알 수 없으므로 물어봐야 한다');
});

check('모르는 곳은 미분류로 둔다', () => {
  const r = seeded().classify_('듣도보도못한가게', 5000, null);
  assert.strictEqual(r.categoryId, null);
});

console.log('\n규칙 학습');

function learner(transactions) {
  const store = createStore({ Transaction: transactions || [] });
  const ctx = load(['Config.gs', 'Util.gs', 'Classify.gs', 'Seed.gs'], store);
  ctx.seedRules_();
  ctx.seedMerchants_();
  return { ctx, store };
}

check('아는 브랜드가 이름에 들어 있으면 그 낱말을 권한다', () => {
  const { ctx } = learner();
  const s = ctx.suggestKeyword_('컴포즈커피발산');
  assert.strictEqual(s.scope, 'contains');
  assert.strictEqual(s.keyword, '컴포즈');
});

check('과거 가맹점과 겹치는 앞부분을 브랜드로 본다', () => {
  const { ctx } = learner([
    { id: 'a', merchantRaw: '동네빵집강남점', categoryId: 'cat_dining' },
  ]);
  const s = ctx.suggestKeyword_('동네빵집역삼점');
  assert.strictEqual(s.scope, 'contains');
  assert.strictEqual(s.keyword, '동네빵집', '지점명 앞까지가 브랜드다');
});

check('짚이는 게 없으면 이름 그대로를 권한다', () => {
  const { ctx } = learner();
  const s = ctx.suggestKeyword_('듣도보도못한가게');
  assert.strictEqual(s.scope, 'exact', '억지로 잘라내면 엉뚱한 곳까지 분류된다');
});

check('exact로 배우면 그 이름만 걸린다', () => {
  const { ctx } = learner();
  ctx.learn_('스타벅스역삼점', 'cat_cafe', 'exact', '스타벅스역삼점');
  assert.strictEqual(ctx.classify_('스타벅스역삼점', 5000, null).categoryId, 'cat_cafe');
});

check('contains로 배우면 다른 지점도 걸린다', () => {
  const { ctx } = learner();
  ctx.learn_('동네빵집역삼점', 'cat_dining', 'contains', '동네빵집');
  const r = ctx.classify_('동네빵집판교점', 4000, null);
  assert.strictEqual(r.categoryId, 'cat_dining', '지점이 달라도 같은 브랜드다');
});

check('once로 고르면 규칙을 만들지 않는다', () => {
  const { ctx, store } = learner();
  const before = store.readAll_('Rule').length;
  ctx.learn_('어쩌다한번집', 'cat_dining', 'once', '어쩌다한번집');
  assert.strictEqual(store.readAll_('Rule').length, before);
  assert.strictEqual(ctx.classify_('어쩌다한번집', 9000, null).categoryId, null);
});

check('같은 낱말로 다시 고르면 규칙이 쌓이지 않고 바뀐다', () => {
  const { ctx, store } = learner();
  ctx.learn_('동네빵집역삼점', 'cat_dining', 'contains', '동네빵집');
  const after1 = store.readAll_('Rule').length;
  ctx.learn_('동네빵집역삼점', 'cat_cafe', 'contains', '동네빵집');   // 생각이 바뀜
  assert.strictEqual(store.readAll_('Rule').length, after1, '규칙이 늘면 안 된다');
  assert.strictEqual(ctx.classify_('동네빵집판교점', 4000, null).categoryId, 'cat_cafe');
});

check('직접 정한 규칙이 기본 규칙을 이긴다', () => {
  const { ctx } = learner();
  ctx.learn_('스타벅스역삼점', 'cat_hobby', 'contains', '스타벅스');   // 카페 아닌 다른 칸으로
  assert.strictEqual(ctx.classify_('스타벅스강남점', 5000, null).categoryId, 'cat_hobby');
});

check('규칙을 만들면 밀려 있던 같은 가게 건들도 정리된다', () => {
  const { ctx, store } = learner([
    { id: 't1', merchantRaw: '동네빵집역삼점', categoryId: '', status: 'pendingCategory' },
    { id: 't2', merchantRaw: '동네빵집판교점', categoryId: '', status: 'pendingCategory' },
    { id: 't3', merchantRaw: '전혀다른곳',     categoryId: '', status: 'pendingCategory' },
  ]);
  const fixed = ctx.applyToPending_('cat_dining', 'contains', '동네빵집');
  assert.strictEqual(fixed, 2);
  assert.strictEqual(store.findBy_('Transaction', 'id', 't3').categoryId, '', '남은 건 그대로여야 한다');
});

check('이미 분류한 건은 새 규칙이 덮어쓰지 않는다', () => {
  const { ctx, store } = learner([
    { id: 't1', merchantRaw: '동네빵집역삼점', categoryId: 'cat_etc', status: 'confirmed' },
  ]);
  ctx.applyToPending_('cat_dining', 'contains', '동네빵집');
  assert.strictEqual(store.findBy_('Transaction', 'id', 't1').categoryId, 'cat_etc',
    '일부러 다르게 넣었을 수 있다');
});

console.log('\n인박스');

function inbox(extra) {
  const store = createStore({
    Account: [{ id: 'acc_hd_emart', name: '현대 이마트Plus', type: 'card', issuer: '현대카드' }],
    ...extra,
  });
  const ctx = load(['Config.gs', 'Util.gs', 'Classify.gs', 'Menu.gs',
                    'Settlement.gs', 'Ingest.gs', 'Ledger.gs', 'Web.gs'], store);
  ctx.seedCategories_ = null;
  return { ctx, store };
}

function seedCats(store) {
  [['cat_dining','외식','🍚'],['cat_cafe','카페','☕'],['cat_delivery','배달','🛵'],
   ['cat_shopping','쇼핑','🛍️']].forEach(function (r, i) {
    store.append_('Category', { id: r[0], name: r[1], icon: r[2], kind: 'expense', sortOrder: i });
  });
}

check('미분류 거래를 화면이 바로 그릴 수 있게 갖춰 보낸다', () => {
  const { ctx, store } = inbox({
    Transaction: [{ id: 't1', type: 'expense', status: 'pendingCategory',
                    amount: 12000, merchantRaw: '네이버파이낸셜',
                    occurredAt: '2026-09-20T21:30:00', accountId: 'acc_hd_emart' }],
  });
  seedCats(store);
  const items = ctx.pendingItems_();
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].merchant, '네이버파이낸셜');
  assert.strictEqual(items[0].amount, 12000);
  assert.strictEqual(items[0].account, '현대 이마트Plus');
  assert.ok(items[0].suggestions.length > 0, '고를 버튼이 있어야 한다');
  assert.ok(items[0].scopeOptions.length >= 2, '범위 선택지가 있어야 한다');
});

check('분류가 끝난 거래는 인박스에 남지 않는다', () => {
  const { ctx, store } = inbox({
    Transaction: [{ id: 't1', type: 'expense', status: 'confirmed',
                    amount: 5000, merchantRaw: '컴포즈커피', occurredAt: '2026-09-20T10:00:00' }],
  });
  seedCats(store);
  assert.strictEqual(ctx.pendingItems_().length, 0);
});

check('같은 자리에 온 적이 있으면 그 사실을 알려 준다', () => {
  const past = function (n) {
    return { id: 'p' + n, type: 'expense', status: 'confirmed', categoryId: 'cat_dining',
             amount: 9000, merchantRaw: '네이버파이낸셜', lat: 37.5, lon: 127.0,
             occurredAt: '2026-09-1' + n + 'T12:00:00' };
  };
  const { ctx, store } = inbox({
    Transaction: [past(1), past(2), past(3),
      { id: 't1', type: 'expense', status: 'pendingCategory', amount: 12000,
        merchantRaw: '네이버파이낸셜', lat: 37.5, lon: 127.0,
        occurredAt: '2026-09-20T21:30:00' }],
  });
  seedCats(store);
  const item = ctx.pendingItems_()[0];
  assert.ok(item.nearbyNote.indexOf('3번') >= 0, item.nearbyNote);
  assert.strictEqual(item.suggestions[0].id, 'cat_dining', '짚이는 것이 맨 앞에 와야 한다');
});

check('읽지 못한 문자만 인박스에 올린다', () => {
  const { ctx, store } = inbox({
    RawMessage: [
      { id: 'r1', body: '해외승인 USD 9.99', parsedOk: false, txnId: '', receivedAt: '2026-09-17T03:12:00' },
      { id: 'r2', body: '정상 문자', parsedOk: true, txnId: 't9', receivedAt: '2026-09-18T03:12:00' },
    ],
  });
  seedCats(store);
  const items = ctx.unparsedItems_();
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].id, 'r1');
});

check('거래로 만든 문자는 인박스에서 빠진다', () => {
  const { ctx, store } = inbox({
    RawMessage: [{ id: 'r1', body: 'x', parsedOk: false, txnId: 't1', receivedAt: '2026-09-17T03:12:00' }],
  });
  seedCats(store);
  assert.strictEqual(ctx.unparsedItems_().length, 0, '이미 거래가 달렸으면 할 일이 아니다');
});

console.log('\n계산 (Ledger)');

function books(extra) {
  const store = createStore({
    Settings: [
      { key: 'monthlyIncome', value: 2800000 },
      { key: 'variableBudget', value: 1300000 },
      { key: 'cycleStartDay', value: 1 },
      ...(extra && extra.Settings ? extra.Settings : []),
    ],
    ...extra,
  });
  if (extra && extra.Settings) store.tables.Settings = createStore({
    Settings: [
      { key: 'monthlyIncome', value: 2800000 },
      { key: 'variableBudget', value: 1300000 },
      { key: 'cycleStartDay', value: 1 },
    ].filter((d) => !extra.Settings.some((e) => e.key === d.key)).concat(extra.Settings),
  }).tables.Settings;
  const ctx = load(['Config.gs', 'Util.gs', 'Classify.gs', 'Ledger.gs'], store);
  return { ctx, store };
}

check('갚을 여력 = 수입 − 고정 − 변동 예산', () => {
  const { ctx } = books({
    RecurringRule: [{ id: 'r1', name: '넷플릭스', expectedAmount: 17000 }],
  });
  const L = ctx.ledger('2026-09');
  assert.strictEqual(L.planned.fixed, 17000);
  assert.strictEqual(L.planned.available, 2800000 - 17000 - 1300000);
});

check('목표일이 있으면 필요한 월 상환액과 부족분을 낸다', () => {
  const { ctx } = books({
    Debt: [{ id: 'd1', name: '리볼빙', balance: 5040000, rate: 17.9 }],
    Settings: [{ key: 'debtTargetDate', value: '2099-01-01' }],
  });
  const L = ctx.ledger('2026-09');
  assert.strictEqual(L.debt.total, 5040000);
  assert.ok(L.debt.needPerMonth > 0);
  assert.strictEqual(typeof L.debt.onTrack, 'boolean');
});

check('여력이 없으면 몇 달 걸리는지 답하지 않는다', () => {
  const { ctx } = books({
    Settings: [{ key: 'monthlyIncome', value: 0 }],
    Debt: [{ id: 'd1', name: '마통', balance: 3000000, rate: 6.8 }],
  });
  assert.strictEqual(ctx.ledger('2026-09').debt.paceMonths, null,
    '0으로 나눠 무한대를 보여주면 안 된다');
});

check('빚은 이자율이 높은 것이 앞에 온다', () => {
  const { ctx } = books({
    Debt: [
      { id: 'd1', name: '마통',   balance: 3200000, rate: 6.8 },
      { id: 'd2', name: '리볼빙', balance: 1840000, rate: 17.9 },
    ],
  });
  const items = ctx.ledger('2026-09').debt.items;
  assert.strictEqual(items[0].name, '리볼빙', '비싼 빚부터 갚아야 총 이자가 적다');
});

check('진행률은 시작 금액 대비로 센다', () => {
  const { ctx } = books({
    Debt: [{ id: 'd1', name: '리볼빙', balance: 5040000, rate: 17.9 }],
    Settings: [{ key: 'debtStartAmount', value: 7000000 }],
  });
  const d = ctx.ledger('2026-09').debt;
  assert.strictEqual(d.paid, 1960000);
  assert.strictEqual(d.progressPct, 28);
});

check('고정지출로 등록한 가게의 결제는 변동지출에서 빠진다', () => {
  const { ctx } = books({
    RecurringRule: [{ id: 'r1', name: '넷플릭스', expectedAmount: 17000 }],
    Transaction: [
      { id: 't1', type: 'expense', amount: 17000, occurredAt: '2026-09-05T00:00:00',
        merchantRaw: '넷플릭스', status: 'confirmed' },
      { id: 't2', type: 'expense', amount: 5000, occurredAt: '2026-09-06T00:00:00',
        merchantRaw: '컴포즈커피', status: 'confirmed' },
    ],
  });
  const a = ctx.ledger('2026-09').actual;
  assert.strictEqual(a.fixed, 17000, '구독은 등록 항목이자 카드 결제이기도 하다');
  assert.strictEqual(a.variable, 5000, '두 번 세면 안 된다');
});

check('이체는 지출로 세지 않는다', () => {
  const { ctx } = books({
    Transaction: [
      { id: 't1', type: 'transfer', amount: 430000, occurredAt: '2026-09-05T00:00:00',
        merchantRaw: '현대카드', status: 'confirmed' },
    ],
  });
  assert.strictEqual(ctx.ledger('2026-09').actual.variable, 0,
    '카드대금을 지출로 잡으면 매달 카드값만큼 부풀어 오른다');
});

check('더치페이로 돌려받은 만큼은 내 지출이 아니다', () => {
  const { ctx } = books({
    Transaction: [
      { id: 't1', type: 'expense', amount: 93800, occurredAt: '2026-09-14T00:00:00',
        merchantRaw: '고깃집', status: 'confirmed', settlementId: 's1' },
    ],
    Settlement: [{ id: 's1', txnId: 't1', expectedAmount: 70350, receivedAmount: 70350 }],
  });
  assert.strictEqual(ctx.ledger('2026-09').actual.variable, 23450);
});

check('지난달 거래는 이번 달에 안 들어온다', () => {
  const { ctx } = books({
    Transaction: [
      { id: 't1', type: 'expense', amount: 50000, occurredAt: '2026-08-31T23:00:00',
        merchantRaw: '지난달', status: 'confirmed' },
    ],
  });
  assert.strictEqual(ctx.ledger('2026-09').actual.variable, 0);
});

console.log('\n카드 두 장 가르기');

function cards(extra) {
  const store = createStore({
    Account: [
      { id: 'acc_woori',    name: '우리은행',        type: 'checking', issuer: '우리은행' },
      { id: 'acc_hd_emart', name: '현대 이마트Plus', type: 'card',     issuer: '현대카드' },
      { id: 'acc_hd_mirae', name: '현대 미래에셋',   type: 'card',     issuer: '현대카드' },
    ],
    ...extra,
  });
  const ctx = load(['Config.gs', 'Util.gs', 'Classify.gs', 'Menu.gs',
                    'Settlement.gs', 'Ingest.gs'], store);
  return { ctx, store };
}

check('카드 상품명으로 계정을 고른다', () => {
  const { ctx } = cards();
  assert.strictEqual(ctx.accountFor_('현대카드', '이마트Plus'), 'acc_hd_emart');
  assert.strictEqual(ctx.accountFor_('현대카드', '미래에셋'), 'acc_hd_mirae');
});

check('상품명을 못 읽어도 금액을 잃지 않는다', () => {
  const { ctx } = cards();
  assert.strictEqual(ctx.accountFor_('현대카드', ''), 'acc_hd_emart',
    '계정이 틀린 편이 기록이 사라지는 것보다 낫다');
});

check('카드값 출금은 청구 예정액이 가까운 카드로 붙는다', () => {
  const { ctx } = cards({
    PaymentSchedule: [
      { id: 's1', accountId: 'acc_hd_emart', dueDate: '2026-10-05', amount: 430000, settled: false },
      { id: 's2', accountId: 'acc_hd_mirae', dueDate: '2026-10-05', amount: 128000, settled: false },
    ],
  });
  assert.strictEqual(ctx.cardAccountForBill_(128000, '2026-10-05T09:00:00'), 'acc_hd_mirae');
  assert.strictEqual(ctx.cardAccountForBill_(430000, '2026-10-05T09:00:00'), 'acc_hd_emart');
});

check('청구 예정이 없는 달이면 아무 카드나 고르고 넘어간다', () => {
  const { ctx } = cards();
  assert.ok(ctx.cardAccountForBill_(300000, '2026-10-05T09:00:00').indexOf('acc_hd_') === 0);
});

console.log('\n시드 채우기');

check('이미 쓰던 시트에 빠진 카테고리만 더한다', () => {
  const store = createStore({
    Category: [{ id: 'cat_cafe', name: '카페' }],   // 예전 시트에 이미 있던 것
  });
  // ensureSheets_ 는 Schema.gs에 있고 SpreadsheetApp을 쓴다.
  // 메모리 저장소에는 만들 시트가 없으므로 비워 둔다.
  const ctx = load(['Config.gs', 'Util.gs', 'Classify.gs', 'Seed.gs'],
                   { ...store, Logger: { log() {} }, ensureSheets_: () => 0 });
  const added = ctx.resync();

  const ids = store.readAll_('Category').map((c) => c.id);
  assert.strictEqual(ids.filter((id) => id === 'cat_cafe').length, 1, '있는 것을 또 넣으면 안 된다');
  assert.ok(ids.indexOf('cat_gathering') >= 0, '새로 생긴 모임이 들어가야 한다');
  assert.ok(added.categories > 0);
});

check('직접 만든 규칙은 건드리지 않는다', () => {
  const store = createStore({
    Rule: [{ id: 'r1', matchType: 'contains', pattern: '스타벅스',
             categoryId: 'cat_hobby', source: 'learned' }],
  });
  const ctx = load(['Config.gs', 'Util.gs', 'Classify.gs', 'Seed.gs'],
                   { ...store, Logger: { log() {} }, ensureSheets_: () => 0 });
  ctx.resync();

  const mine = store.readAll_('Rule').filter((r) => r.source === 'learned');
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].categoryId, 'cat_hobby', '내가 정한 것이 기본값으로 덮이면 안 된다');
});

check('여러 번 실행해도 늘어나지 않는다', () => {
  const store = createStore({});
  const ctx = load(['Config.gs', 'Util.gs', 'Classify.gs', 'Seed.gs'],
                   { ...store, Logger: { log() {} }, ensureSheets_: () => 0 });
  ctx.resync();
  const after1 = store.readAll_('Rule').length;
  ctx.resync();
  assert.strictEqual(store.readAll_('Rule').length, after1);
});

console.log('\n단축어 메뉴');

function menuCtx(transactions) {
  const store = createStore({ Transaction: transactions || [] });
  const ctx = load(['Config.gs', 'Util.gs', 'Classify.gs', 'Menu.gs', 'Seed.gs', 'Ingest.gs'], store);
  ctx.seedCategories_();
  ctx.seedRules_();
  ctx.seedMerchants_();
  return { ctx, store };
}

check('메뉴는 줄바꿈으로 이어진 글자다', () => {
  const { ctx } = menuCtx();
  const lines = ctx.categoryMenuText_({}).split('\n');
  assert.ok(lines.length >= 10, '지출 카테고리가 모두 들어가야 한다');
  assert.ok(lines.some((l) => l.indexOf('카페') >= 0));
  assert.ok(lines.every((l) => l.indexOf('급여') < 0), '수입은 지출 메뉴에 없어야 한다');
});

check('위치로 짚인 카테고리가 메뉴 맨 앞에 온다', () => {
  const { ctx } = menuCtx();
  const decision = { nearby: { categoryId: 'cat_medical', samples: 4, confident: true } };
  assert.ok(ctx.categoryMenuText_(decision).split('\n')[0].indexOf('의료') >= 0);
});

check('메뉴에서 고른 글자를 카테고리로 되돌린다', () => {
  const { ctx } = menuCtx();
  assert.strictEqual(ctx.resolveCategory_('☕ 카페'), 'cat_cafe', '아이콘이 붙어 돌아온다');
  assert.strictEqual(ctx.resolveCategory_('카페'), 'cat_cafe');
  assert.strictEqual(ctx.resolveCategory_('cat_cafe'), 'cat_cafe');
  assert.strictEqual(ctx.resolveCategory_('없는카테고리'), null);
});

check('범위 메뉴는 아는 브랜드를 첫 줄에 둔다', () => {
  const { ctx } = menuCtx();
  const lines = ctx.scopeMenuText_('컴포즈커피발산').split('\n');
  assert.strictEqual(lines[0], '모두: 컴포즈');
  assert.strictEqual(lines[1], '이 가게만: 컴포즈커피발산');
  assert.strictEqual(lines[2], '이번만');
});

check('짚이는 브랜드가 없으면 "모두" 줄을 안 만든다', () => {
  const { ctx } = menuCtx();
  const lines = ctx.scopeMenuText_('듣도보도못한가게').split('\n');
  assert.strictEqual(lines.length, 2, '고를 수 없는 선택지를 띄우면 안 된다');
  assert.ok(lines[0].indexOf('이 가게만') === 0);
});

check('범위 메뉴에서 고른 글자를 그대로 해석한다', () => {
  const { ctx } = menuCtx();
  const merchant = '컴포즈커피발산';
  const menu = ctx.scopeMenuText_(merchant).split('\n');

  assert.deepStrictEqual(plain(ctx.parseScopeChoice_(menu[0], merchant)),
    { scope: 'contains', keyword: '컴포즈' });
  assert.deepStrictEqual(plain(ctx.parseScopeChoice_(menu[1], merchant)),
    { scope: 'exact', keyword: '컴포즈커피발산' });
  assert.strictEqual(ctx.parseScopeChoice_(menu[2], merchant).scope, 'once');
});

check('범위를 안 고르면 권하는 범위를 쓴다', () => {
  const { ctx } = menuCtx();
  assert.strictEqual(ctx.parseScopeChoice_('', '컴포즈커피발산').scope, 'contains');
});

check('알림 문구에 배운 내용이 들어간다', () => {
  const { ctx } = menuCtx();
  const msg = ctx.confirmMessage_('cat_cafe', { scope: 'contains', keyword: '컴포즈' }, 2);
  assert.ok(msg.indexOf('카페') >= 0);
  assert.ok(msg.indexOf('컴포즈') >= 0);
  assert.ok(msg.indexOf('2건') >= 0);
});

console.log('\n위치 매칭');

check('같은 자리 기록이 쌓이면 자동 분류한다', () => {
  const here = { lat: 37.5000, lon: 127.0000 };
  const near = (n) => ({
    id: 'txn' + n, type: 'expense', categoryId: 'cat_dining',
    lat: 37.5000 + n * 0.00001, lon: 127.0000,     // 약 1m 간격
  });
  const { ctx } = withStore({ Transaction: [near(1), near(2), near(3)] });
  const r = ctx.nearbyCategory_(here);
  assert.strictEqual(r.categoryId, 'cat_dining');
  assert.strictEqual(r.confident, true);
});

check('표본이 적으면 확정하지 않는다', () => {
  const { ctx } = withStore({
    Transaction: [{ id: 'a', type: 'expense', categoryId: 'cat_dining', lat: 37.5, lon: 127.0 }],
  });
  const r = ctx.nearbyCategory_({ lat: 37.5, lon: 127.0 });
  assert.strictEqual(r.confident, false, '한 번 간 곳으로 단정하면 안 된다');
  assert.strictEqual(r.categoryId, 'cat_dining', '제안은 할 수 있다');
});

check('카테고리가 갈리면 확정하지 않는다', () => {
  const at = (id, cat) => ({ id, type: 'expense', categoryId: cat, lat: 37.5, lon: 127.0 });
  const { ctx } = withStore({
    Transaction: [at('a', 'cat_dining'), at('b', 'cat_cafe'), at('c', 'cat_shopping')],
  });
  assert.strictEqual(ctx.nearbyCategory_({ lat: 37.5, lon: 127.0 }).confident, false);
});

check('멀리 떨어진 기록은 세지 않는다', () => {
  const far = (n) => ({ id: 'f' + n, type: 'expense', categoryId: 'cat_dining', lat: 37.51, lon: 127.0 });
  const { ctx } = withStore({ Transaction: [far(1), far(2), far(3)] });
  const r = ctx.nearbyCategory_({ lat: 37.5, lon: 127.0 });   // 약 1.1km
  assert.strictEqual(r.samples, 0);
});

check('좌표가 없으면 조용히 건너뛴다', () => {
  const { ctx } = withStore({ Transaction: [] });
  assert.strictEqual(ctx.nearbyCategory_(null).confident, false, '지하에서 위치를 못 잡아도 죽으면 안 된다');
});

check('간편결제는 이름이 뭉개져도 위치로 분류된다', () => {
  const at = (n) => ({
    id: 'p' + n, type: 'expense', categoryId: 'cat_dining',
    merchantRaw: '네이버파이낸셜', lat: 37.5, lon: 127.0,
  });
  const { ctx } = withStore({
    Transaction: [at(1), at(2), at(3)],
    Merchant: [{ id: 'm1', normalizedName: '네이버파이낸셜', isPassthrough: true, alwaysAsk: false }],
  });
  const r = ctx.classify_('네이버파이낸셜', 12000, { lat: 37.5, lon: 127.0 });
  assert.strictEqual(r.categoryId, 'cat_dining');
  assert.strictEqual(r.reason, 'passthrough-location');
});

check('간편결제인데 위치 기록이 없으면 물어본다', () => {
  const { ctx } = withStore({
    Transaction: [],
    Merchant: [{ id: 'm1', normalizedName: '네이버파이낸셜', isPassthrough: true, alwaysAsk: false }],
  });
  const r = ctx.classify_('네이버파이낸셜', 12000, { lat: 37.5, lon: 127.0 });
  assert.strictEqual(r.categoryId, null);
  assert.strictEqual(r.reason, 'passthrough');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
