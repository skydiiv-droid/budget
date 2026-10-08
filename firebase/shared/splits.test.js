import test from 'node:test';
import assert from 'node:assert/strict';
import { splitParts, hasSplit, cleanSplits, partIn, SPLIT_MAX } from './splits.js';

const mart = {
  id: 't1', type: 'expense', amount: 20_000, categoryId: 'cat_grocery',
  splits: [{ categoryId: 'cat_hobby', amount: 5_000 }],
};

test('안 쪼갠 거래는 한 조각이다', () => {
  const parts = splitParts({ amount: 9_000, categoryId: 'cat_cafe' });
  assert.deepEqual(parts, [{ categoryId: 'cat_cafe', amount: 9_000, rest: true }]);
});

test('다 적지 않으면 남은 금액은 그 거래의 카테고리로 간다', () => {
  // "2만원 중 5천원만 취미" — 나머지 1만5천은 적지 않아도 식비로 간다
  assert.deepEqual(splitParts(mart), [
    { categoryId: 'cat_hobby', amount: 5_000, rest: false },
    { categoryId: 'cat_grocery', amount: 15_000, rest: true },
  ]);
});

test('조각 합은 언제나 금액과 같다', () => {
  for (const net of [20_000, 12_000, 7_777, 0]) {
    const sum = splitParts(mart, net).reduce((s, p) => s + p.amount, 0);
    assert.equal(sum, net, `${net} 인데 조각 합이 ${sum}`);
  }
});

test('합이 금액을 넘으면 비례로 깎는다', () => {
  // 나눠 둔 뒤에 절반을 돌려받았다. 카테고리 합이 총액을 넘으면 안 된다.
  const t = { amount: 20_000, categoryId: 'cat_grocery',
    splits: [{ categoryId: 'cat_hobby', amount: 5_000 },
             { categoryId: 'cat_food', amount: 15_000 }] };
  const parts = splitParts(t, 10_000);
  assert.deepEqual(parts.map((p) => p.amount), [2_500, 7_500]);
  assert.equal(parts.reduce((s, p) => s + p.amount, 0), 10_000);
});

test('0원이 된 거래는 조각이 남지 않는다', () => {
  // 통째로 돌려받은 건이다. 세는 돈이 없으니 카테고리에 넣을 것도 없다.
  assert.deepEqual(splitParts(mart, 0), []);
});

test('빈 줄과 0원 조각은 세지 않는다', () => {
  const t = { amount: 10_000, categoryId: 'cat_cafe',
    splits: [{ categoryId: '', amount: 3_000 }, { categoryId: 'cat_hobby', amount: 0 }] };
  assert.equal(hasSplit(t), false);
  assert.deepEqual(splitParts(t), [{ categoryId: 'cat_cafe', amount: 10_000, rest: true }]);
});

test('그 카테고리에 얼마가 들어갔나', () => {
  assert.equal(partIn(mart, 'cat_hobby'), 5_000);
  assert.equal(partIn(mart, 'cat_grocery'), 15_000);
  assert.equal(partIn(mart, new Set(['cat_hobby', 'cat_grocery'])), 20_000);
  assert.equal(partIn(mart, 'cat_cafe'), 0);
});

test('합이 금액을 넘으면 저장하지 않는다', () => {
  const r = cleanSplits([{ categoryId: 'cat_hobby', amount: 15_000 },
                         { categoryId: 'cat_food', amount: 10_000 }], 20_000);
  assert.equal(r.ok, false);
  assert.equal(r.over, 5_000);
});

test('모자란 것은 막지 않는다 — 남은 금액이 어디로 갈지 알려 준다', () => {
  const r = cleanSplits([{ categoryId: 'cat_hobby', amount: 5_000 }], 20_000);
  assert.equal(r.ok, true);
  assert.equal(r.rest, 15_000);
  assert.deepEqual(r.splits, [{ categoryId: 'cat_hobby', amount: 5_000 }]);
});

test('조각을 다 지우면 분할이 풀린다', () => {
  const r = cleanSplits([{ categoryId: '', amount: 0 }], 20_000);
  assert.equal(r.ok, true);
  assert.deepEqual(r.splits, []);
});

test('너무 잘게 나누지는 않는다', () => {
  const many = Array.from({ length: SPLIT_MAX + 1 },
    (_, i) => ({ categoryId: `c${i}`, amount: 100 }));
  assert.equal(cleanSplits(many, 20_000).ok, false);
});
