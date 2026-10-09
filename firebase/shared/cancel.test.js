import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findOriginal, openCancels, voidPatch, findPartial, partialPatch, partlyCancelled } from './cancel.js';

const day = (d, h = 12) => `2026-09-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00`;
const buy = (id, d, amount, merchant, card = 'acc_a') =>
  ({ id, type: 'expense', amount, merchantRaw: merchant, accountId: card, occurredAt: day(d) });

test('같은 카드 같은 금액이면 맞물린다', () => {
  const txns = [buy('t1', 15, 1800, '컴포즈커피발산')];
  const r = findOriginal({ id: 'c1', amount: 1800, accountId: 'acc_a',
    merchantRaw: '컴포즈커피발산', occurredAt: day(16) }, txns);
  assert.equal(r.match.id, 't1');
  assert.equal(r.confident, true, '하나뿐이고 가깝고 가게까지 맞으면 묻지 않는다');
});

test('다른 카드 건은 건드리지 않는다', () => {
  const txns = [buy('t1', 15, 1800, '컴포즈커피', 'acc_b')];
  const r = findOriginal({ id: 'c1', amount: 1800, accountId: 'acc_a', occurredAt: day(16) }, txns);
  assert.equal(r.match, null);
});

test('금액이 다르면 후보가 아니다', () => {
  const txns = [buy('t1', 15, 1900, '컴포즈커피')];
  const r = findOriginal({ id: 'c1', amount: 1800, accountId: 'acc_a', occurredAt: day(16) }, txns);
  assert.equal(r.match, null);
});

test('취소보다 나중 결제는 후보가 아니다', () => {
  const txns = [buy('t1', 18, 1800, '컴포즈커피')];
  const r = findOriginal({ id: 'c1', amount: 1800, accountId: 'acc_a', occurredAt: day(16) }, txns);
  assert.equal(r.match, null, '아직 일어나지 않은 결제를 취소할 수는 없다');
});

test('같은 금액이 여럿이면 자동으로 정하지 않는다', () => {
  const txns = [buy('t1', 15, 1800, '컴포즈커피'), buy('t2', 16, 1800, '컴포즈커피')];
  const r = findOriginal({ id: 'c1', amount: 1800, accountId: 'acc_a',
    merchantRaw: '컴포즈커피', occurredAt: day(17) }, txns);
  assert.equal(r.candidates.length, 2);
  assert.equal(r.confident, false, '엉뚱한 쪽을 지우면 찾기가 더 어렵다');
  assert.equal(r.match.id, 't2', '그래도 가까운 것을 먼저 보여 준다');
});

test('가맹점이 붙어 있으면 그걸로 좁힌다', () => {
  const txns = [buy('t1', 15, 1800, 'GS25발산'), buy('t2', 15, 1800, '컴포즈커피발산')];
  const r = findOriginal({ id: 'c1', amount: 1800, accountId: 'acc_a',
    merchantRaw: '컴포즈커피발산', occurredAt: day(16) }, txns);
  assert.equal(r.match.id, 't2');
  assert.equal(r.confident, true);
});

test('가맹점이 없으면 금액과 카드만으로 찾되 묻는다', () => {
  const txns = [buy('t1', 15, 1800, '컴포즈커피발산')];
  const r = findOriginal({ id: 'c1', amount: 1800, accountId: 'acc_a', occurredAt: day(16) }, txns);
  assert.equal(r.match.id, 't1');
  assert.equal(r.confident, true, '후보가 하나뿐이면 가맹점이 없어도 확실하다');
});

test('오래된 건은 가까운 것으로 치지 않는다', () => {
  const old = { ...buy('t1', 1, 1800, '컴포즈커피'), occurredAt: '2026-08-20T12:00:00' };
  const r = findOriginal({ id: 'c1', amount: 1800, accountId: 'acc_a',
    merchantRaw: '컴포즈커피', occurredAt: day(16) }, [old]);
  assert.equal(r.match.id, 't1', '두 달 안이면 후보이긴 하다');
  assert.equal(r.confident, false, '한참 전 것을 말없이 지우면 안 된다');
});

test('이미 취소된 건은 두 번 취소하지 않는다', () => {
  const txns = [{ ...buy('t1', 15, 1800, '컴포즈커피'), status: 'voided' }];
  const r = findOriginal({ id: 'c1', amount: 1800, accountId: 'acc_a', occurredAt: day(16) }, txns);
  assert.equal(r.match, null);
});

test('맞물리지 않은 취소만 정리 목록에 남는다', () => {
  const list = [
    { id: 'c1', type: 'cancel' },
    { id: 'c2', type: 'cancel', status: 'settled', offsetsId: 't9' },
    { id: 't1', type: 'expense' },
  ];
  assert.deepEqual(openCancels(list).map((t) => t.id), ['c1']);
});

test('취소된 결제에는 누가 취소했는지 남는다', () => {
  const patch = voidPatch({ id: 'c1', occurredAt: day(16) });
  assert.equal(patch.status, 'voided');
  assert.equal(patch.voidedBy, 'c1', '나중에 되돌리려면 누가 지웠는지 알아야 한다');
});

// ── 부분취소 ─────────────────────────────────────────────
// 3만원 긁고 1만원만 취소되는 일이 있다. 금액이 같은 것만 찾고 있었으니
// 이런 취소는 영영 못 맞물리고, 원결제는 전액으로 남아 누적과 안 맞았다.

const PCARD = '현대 미래에셋';
const swipe = (id, amount, at, merchant = '이마트', extra = {}) =>
  ({ id, type: 'expense', amount, occurredAt: at, merchantRaw: merchant,
     cardName: PCARD, status: 'confirmed', ...extra });
const kill = (id, amount, at, merchant = '') =>
  ({ id, type: 'cancel', amount, occurredAt: at, merchantRaw: merchant, cardName: PCARD });

test('금액이 작은 취소는 큰 결제에서 깎인 것이다', () => {
  const txns = [swipe('t1', 30_000, '2026-09-10T12:00:00'), swipe('t2', 8_000, '2026-09-10T13:00:00')];
  const c = kill('c1', 10_000, '2026-09-11T10:00:00');

  assert.equal(findOriginal(c, txns).match, null, '같은 금액으로는 못 찾는다');
  const list = findPartial(c, txns);
  assert.deepEqual(list.map((t) => t.id), ['t1'], '취소보다 큰 것만 후보다');
});

test('가맹점이 맞는 것을 앞에 둔다', () => {
  const txns = [
    swipe('old', 50_000, '2026-09-05T12:00:00', '이마트'),
    swipe('new', 50_000, '2026-09-10T12:00:00', '쿠팡'),
  ];
  const list = findPartial(kill('c1', 10_000, '2026-09-11T10:00:00', '이마트'), txns);
  assert.deepEqual(list.map((t) => t.id), ['old', 'new'], '가까운 것보다 이름이 맞는 것이 먼저');
});

test('맞물리면 금액을 깎고 원래 금액을 남긴다', () => {
  const t = swipe('t1', 30_000, '2026-09-10T12:00:00');
  const p = partialPatch(t, kill('c1', 10_000, '2026-09-11T10:00:00'));
  assert.equal(p.amount, 20_000, '누적에서도 취소분이 빠진다 — 안 깎으면 과다 집계로 뜬다');
  assert.equal(p.amountBefore, 30_000, '깎고 나면 원래 얼마였는지 알 길이 없다');
  assert.equal(p.cancelledAmount, 10_000);
  assert.deepEqual(p.cancelIds, ['c1']);
  assert.equal(p.status, undefined, '아직 남은 금액이 있다');
});

test('두 번 나눠 취소돼도 쌓인다', () => {
  const once = { ...swipe('t1', 30_000, '2026-09-10T12:00:00'),
                 ...partialPatch(swipe('t1', 30_000, '2026-09-10T12:00:00'),
                                 kill('c1', 10_000, '2026-09-11T10:00:00')) };
  const twice = partialPatch(once, kill('c2', 5_000, '2026-09-12T10:00:00'));
  assert.equal(twice.amount, 15_000);
  assert.equal(twice.amountBefore, 30_000, '원래 금액은 처음 것을 그대로 둔다');
  assert.equal(twice.cancelledAmount, 15_000);
  assert.deepEqual(twice.cancelIds, ['c1', 'c2']);
});

test('깎아서 0이 되면 없던 일이 된다', () => {
  const t = swipe('t1', 10_000, '2026-09-10T12:00:00');
  // 금액이 같으면 전액 취소 쪽이 맡지만, 두 번째 부분취소로 0이 될 수 있다
  const p = partialPatch({ ...t, amount: 4_000, amountBefore: 10_000, cancelledAmount: 6_000 },
    kill('c2', 4_000, '2026-09-12T10:00:00'));
  assert.equal(p.amount, 0);
  assert.equal(p.status, 'voided');
  assert.equal(partlyCancelled(p), true);
});

test('취소보다 작거나 같은 결제는 후보가 아니다', () => {
  const txns = [swipe('same', 10_000, '2026-09-10T12:00:00'), swipe('small', 5_000, '2026-09-10T12:00:00')];
  assert.deepEqual(findPartial(kill('c1', 10_000, '2026-09-11T10:00:00'), txns), []);
});
