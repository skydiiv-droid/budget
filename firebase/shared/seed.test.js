import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryDocs, ruleDocs, merchantDocs, accountDocs } from './seed.js';
import { classify } from './classify.js';

test('카테고리 id 가 겹치지 않는다', () => {
  const ids = categoryDocs().map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('하위 카테고리의 부모가 실제로 있다', () => {
  const ids = new Set(categoryDocs().map((c) => c.id));
  for (const c of categoryDocs()) {
    if (c.parentId) assert.ok(ids.has(c.parentId), `${c.name} 의 부모 ${c.parentId} 가 없다`);
  }
});

test('규칙이 가리키는 카테고리가 실제로 있다', () => {
  const ids = new Set(categoryDocs().map((c) => c.id));
  for (const r of ruleDocs()) {
    assert.ok(ids.has(r.categoryId), `${r.pattern} 가 없는 카테고리 ${r.categoryId} 를 가리킨다`);
  }
});

test('기본 규칙으로 자주 가는 곳이 갈린다', () => {
  const rules = ruleDocs();
  const merchants = merchantDocs();
  const of = (m) => classify(m, { rules, merchants }).categoryId;

  assert.equal(of('컴포즈커피발산'), 'cat_cafe');
  assert.equal(of('이마트24 역삼점'), 'cat_convenience', '"이마트"에 먼저 걸리면 안 된다');
  assert.equal(of('쿠팡이츠'), 'cat_delivery', '"쿠팡"에 먼저 걸리면 안 된다');
  assert.equal(of('ANTHROPIC CLAUDE'), 'cat_sub_digital');
  assert.equal(of('네이버파이낸셜'), null, '간편결제는 물어봐야 한다');
});

test('카드는 두 장이 따로 있다', () => {
  const cards = accountDocs().filter((a) => a.type === 'card');
  assert.equal(cards.length, 2, '누적 사용금액이 카드마다 따로 온다');
});
