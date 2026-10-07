import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryDocs, ruleDocs, merchantDocs, accountDocs, RULES, ruleId } from './seed.js';
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

  // 하위는 늘려 갈 자리다. 이름을 못 박지 않고 있어야 할 것만 본다.
  const food = cats.filter((c) => c.parentId === 'cat_food').map((c) => c.name);
  for (const must of ['배달', '외식', '카페', '편의점']) {
    assert.ok(food.includes(must), `식비 아래 ${must} 가 있어야 한다`);
  }
  assert.ok(cats.filter((c) => c.parentId).length >= 30,
    `하위가 넉넉해야 고를 것이 있다 (지금 ${cats.filter((c) => c.parentId).length}개)`);
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
  assert.equal(of('하이마트 마곡'), 'cat_digital', '"이마트"에 먼저 걸리면 안 된다');
  assert.equal(of('마곡연세내과'), 'cat_clinic');
  assert.equal(of('온누리약국'), 'cat_pharmacy');
  assert.equal(of('bhc치킨 발산'), 'cat_delivery', '소문자로 찍혀도 걸려야 한다');
  assert.equal(of('이자카야 소라'), 'cat_alcohol', '"이자"에 먼저 걸리면 안 된다');
  assert.equal(of('네이버파이낸셜'), null, '간편결제는 물어봐야 한다');
});

test('카드는 두 장이 따로 있다', () => {
  const cards = accountDocs().filter((a) => a.type === 'card');
  assert.equal(cards.length, 2, '누적 사용금액이 카드마다 따로 온다');
});

// ── 카테고리 나무와 규칙이 서로 맞는지 ───────────────────

test('카테고리 id 는 겹치지 않는다', () => {
  const ids = categoryDocs().map((c) => c.id);
  assert.deepEqual([...new Set(ids)], ids);
});

test('세 단계로는 가지 않는다', () => {
  // 고르는 화면이 두 단계까지만 펼친다. 세 단계를 만들면 안 보이는 칸이 생긴다.
  const cats = categoryDocs();
  const deep = cats.filter((c) => c.parentId
    && cats.find((x) => x.id === c.parentId)?.parentId);
  assert.deepEqual(deep.map((c) => c.id), []);
});

test('하위는 상위와 같은 종류여야 한다', () => {
  // 지출 갈래 아래 수입 칸이 끼면 고르는 화면에서 사라진다.
  const cats = categoryDocs();
  const odd = cats.filter((c) => {
    const parent = c.parentId && cats.find((x) => x.id === c.parentId);
    return parent && parent.kind !== c.kind;
  });
  assert.deepEqual(odd.map((c) => c.id), []);
});

test('규칙은 있는 카테고리를 가리킨다', () => {
  const ids = new Set(categoryDocs().map((c) => c.id));
  assert.deepEqual(RULES.filter(([, , cat]) => !ids.has(cat)), []);
});

test('같은 낱말을 두 번 적어 두지 않는다', () => {
  const pats = RULES.map(([, p]) => p);
  assert.deepEqual(pats.filter((p, i) => pats.indexOf(p) !== i), []);
});

test('문서 id 는 낱말에서 나온다 — 번호로 지으면 끼워 넣을 때 뜻이 밀린다', () => {
  const docs = ruleDocs();
  assert.equal(docs.length, RULES.length);
  assert.deepEqual([...new Set(docs.map((d) => d.id))].length, docs.length);
  // 중간에 하나 끼워 넣어도 다른 규칙의 id 가 변하지 않는다
  assert.equal(ruleId('이마트24'), docs.find((d) => d.pattern === '이마트24').id);
});

test('품은 낱말과 품긴 낱말은 순서가 정해져 있어야 한다', () => {
  // 규칙은 Firestore 에서 문서 id 순으로 온다. 같은 priority 로 두면
  // "스타벅스"가 "벅스"보다 먼저 걸릴지를 아무도 보장해 주지 않는다.
  const low = (s) => s.toLowerCase();
  const bad = [];
  for (const [pa, a, ca] of RULES) {
    for (const [pb, b, cb] of RULES) {
      if (a === b || ca === cb) continue;
      if (!low(b).includes(low(a))) continue;      // a 가 b 안에 들어 있다
      // 좁은 쪽(b)이 먼저 걸려야 한다
      if (pb >= pa) bad.push(`${b}(${pb}) 이 ${a}(${pa}) 보다 먼저 걸려야 한다`);
    }
  }
  assert.deepEqual(bad, []);
});
