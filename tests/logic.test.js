/** 정산(더치페이) 금액 계산과 위치 매칭 테스트. */
const assert = require('assert');
const { load } = require('./harness');
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
