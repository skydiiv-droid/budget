import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findOriginal, openCancels, voidPatch } from './cancel.js';

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
