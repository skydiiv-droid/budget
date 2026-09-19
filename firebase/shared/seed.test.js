import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryDocs, ruleDocs, merchantDocs, accountDocs } from './seed.js';
import { classify } from './classify.js';

test('카테고리 id 가 겹치지 않는다', () => {
  const ids = categoryDocs().map((c) => c.id);
  const dup = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  assert.deepEqual(dup, [], '같은 id 가 둘이면 하나가 다른 하나를 덮어쓴다');
});

test('큰 갈래 아래로 정리돼 있다', () => {
  const cats = categoryDocs().filter((c) => c.kind === 'expense' && !c.hidden);
  const mains = cats.filter((c) => !c.parentId);
  assert.ok(mains.length >= 8 && mains.length <= 12,
    `한 화면에 늘어놓을 만해야 한다 (지금 ${mains.length}개)`);

  const food = cats.filter((c) => c.parentId === 'cat_food').map((c) => c.name);
  assert.deepEqual(food, ['배달', '외식', '카페', '편의점', '마트']);
});

test('예전 칸은 목록에서 숨기되 이름은 남긴다', () => {
  const legacy = categoryDocs().filter((c) => c.hidden);
  assert.ok(legacy.length > 0, '지난 거래가 가리키고 있어 지우면 이름을 잃는다');
  assert.ok(legacy.every((c) => c.name));
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
  assert.equal(of('ANTHROPIC CLAUDE'), 'cat_subscription');
  assert.equal(of('네이버파이낸셜'), null, '간편결제는 물어봐야 한다');
});

test('카드는 두 장이 따로 있다', () => {
  const cards = accountDocs().filter((a) => a.type === 'card');
  assert.equal(cards.length, 2, '누적 사용금액이 카드마다 따로 온다');
});
