import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, nearbyCategory, suggestKeyword, haversineMeters } from './classify.js';

const RULES = [
  { id: 'r1', priority: 10, matchType: 'contains', pattern: '이마트24', categoryId: 'cat_convenience', source: 'builtin' },
  { id: 'r2', priority: 20, matchType: 'contains', pattern: '이마트', categoryId: 'cat_grocery', source: 'builtin' },
  { id: 'r3', priority: 10, matchType: 'contains', pattern: '쿠팡이츠', categoryId: 'cat_delivery', source: 'builtin' },
  { id: 'r4', priority: 20, matchType: 'contains', pattern: '쿠팡', categoryId: 'cat_shopping', source: 'builtin' },
  { id: 'r5', priority: 20, matchType: 'contains', pattern: '컴포즈', categoryId: 'cat_cafe', source: 'builtin' },
];

const PASSTHROUGH = [
  { id: 'm1', normalizedName: '네이버파이낸셜', isPassthrough: true },
];

const here = { lat: 37.5, lon: 127.0 };
const past = (n, categoryId = 'cat_dining') => ({
  id: `p${n}`, type: 'expense', categoryId,
  merchantRaw: '네이버파이낸셜', lat: 37.5 + n * 0.00001, lon: 127.0,
});

test('좁은 규칙이 넓은 규칙을 이긴다', () => {
  assert.equal(classify('이마트24 역삼점', { rules: RULES }).categoryId, 'cat_convenience');
  assert.equal(classify('쿠팡이츠', { rules: RULES }).categoryId, 'cat_delivery');
  assert.equal(classify('이마트 성수점', { rules: RULES }).categoryId, 'cat_grocery');
});

test('모르는 곳은 미분류로 둔다', () => {
  assert.equal(classify('듣도보도못한가게', { rules: RULES }).categoryId, null);
});

test('간편결제는 이름으로 분류하지 않는다', () => {
  const r = classify('네이버파이낸셜', { rules: RULES, merchants: PASSTHROUGH });
  assert.equal(r.categoryId, null);
  assert.equal(r.reason, 'passthrough', '무엇을 샀는지 알 수 없으므로 물어봐야 한다');
});

test('간편결제도 같은 자리 기록이 쌓이면 갈린다', () => {
  const r = classify('네이버파이낸셜', {
    rules: RULES, merchants: PASSTHROUGH,
    transactions: [past(1), past(2), past(3)], location: here,
  });
  assert.equal(r.categoryId, 'cat_dining');
  assert.equal(r.reason, 'passthrough-location');
});

test('직접 정한 규칙이 기본 규칙을 이긴다', () => {
  const mine = { id: 'x', priority: 10, matchType: 'contains', pattern: '컴포즈',
                 categoryId: 'cat_hobby', source: 'learned' };
  assert.equal(classify('컴포즈커피발산', { rules: [...RULES, mine] }).categoryId, 'cat_hobby');
});

test('가맹점에 붙은 기본 카테고리가 규칙보다 먼저다', () => {
  const merchants = [{ id: 'm2', normalizedName: '컴포즈커피발산', defaultCategoryId: 'cat_etc' }];
  assert.equal(classify('컴포즈커피발산', { rules: RULES, merchants }).categoryId, 'cat_etc');
});

test('표본이 적으면 위치로 확정하지 않는다', () => {
  const r = nearbyCategory(here, [past(1)]);
  assert.equal(r.confident, false, '한 번 간 곳으로 단정하면 안 된다');
  assert.equal(r.categoryId, 'cat_dining', '제안은 할 수 있다');
});

test('카테고리가 갈리면 위치로 확정하지 않는다', () => {
  const mixed = [past(1, 'cat_dining'), past(2, 'cat_cafe'), past(3, 'cat_shopping')];
  assert.equal(nearbyCategory(here, mixed).confident, false);
});

test('멀리 떨어진 기록은 세지 않는다', () => {
  const far = [1, 2, 3].map((n) => ({ ...past(n), lat: 37.51 }));
  assert.equal(nearbyCategory(here, far).samples, 0, '약 1.1km 떨어진 곳이다');
});

test('좌표가 없으면 조용히 건너뛴다', () => {
  assert.equal(nearbyCategory(null, []).confident, false, '지하에서 못 잡아도 죽으면 안 된다');
  assert.equal(nearbyCategory({ lat: null, lon: null }, []).confident, false);
});

test('거리 계산이 맞다', () => {
  assert.equal(Math.round(haversineMeters(37.5, 127.0, 37.5, 127.0)), 0);
  const km = haversineMeters(37.5, 127.0, 37.51, 127.0);
  assert.ok(km > 1000 && km < 1200, `위도 0.01도는 약 1.1km (${Math.round(km)}m)`);
});

test('아는 브랜드가 이름에 들어 있으면 그 낱말을 권한다', () => {
  const s = suggestKeyword('컴포즈커피발산', { rules: RULES });
  assert.equal(s.scope, 'contains');
  assert.equal(s.keyword, '컴포즈');
});

test('과거 가맹점과 겹치는 앞부분을 브랜드로 본다', () => {
  const s = suggestKeyword('동네빵집역삼점', {
    rules: RULES, transactions: [{ merchantRaw: '동네빵집강남점' }],
  });
  assert.equal(s.keyword, '동네빵집', '지점명 앞까지가 브랜드다');
});

test('짚이는 게 없으면 이름 그대로를 권한다', () => {
  const s = suggestKeyword('듣도보도못한가게', { rules: RULES });
  assert.equal(s.scope, 'exact', '억지로 잘라내면 엉뚱한 곳까지 분류된다');
});
