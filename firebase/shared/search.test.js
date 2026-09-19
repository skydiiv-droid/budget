import { test } from 'node:test';
import assert from 'node:assert/strict';
import { search, terms, knownTags, parseTags } from './search.js';
import { toCSV, HEADERS } from './csv.js';

const CATS = [
  { id: 'cat_food', name: '식비', parentId: '' },
  { id: 'cat_cafe', name: '카페', parentId: 'cat_food' },
  { id: 'cat_medical', name: '의료', parentId: '' },
];
const TXNS = [
  { id: 't1', type: 'expense', amount: 12_000, occurredAt: '2026-09-11T14:20:00',
    merchantRaw: '마곡연세내과', categoryId: 'cat_medical', cardName: '현대 이마트Plus' },
  { id: 't2', type: 'expense', amount: 1_800, occurredAt: '2026-09-19T19:14:00',
    merchantRaw: '컴포즈커피발산', categoryId: 'cat_cafe', tags: ['출근길'] },
  { id: 't3', type: 'expense', amount: 47_000, occurredAt: '2026-09-15T18:30:00',
    merchantRaw: '한신포차발산', categoryId: 'cat_food', memo: '수민이랑', tags: ['모임', '2026제주'] },
  { id: 'c1', type: 'cancel', amount: 1_800, occurredAt: '2026-09-20T10:00:00',
    merchantRaw: '컴포즈커피발산' },
];
const find = (q) => search(q, { transactions: TXNS, categories: CATS }).map((t) => t.id);

test('이름 앞부분만 쳐도 찾아진다', () => {
  assert.deepEqual(find('컴포즈'), ['t2'], '지점명까지 외우고 있을 리 없다');
  assert.deepEqual(find('연세'), ['t1'], '가운데 토막도 걸린다');
});

test('카테고리 이름으로도 찾는다', () => {
  assert.deepEqual(find('카페'), ['t2'], '어디에 적어 뒀는지까지 기억해야 하면 찾기가 아니다');
  assert.deepEqual(find('의료'), ['t1']);
});

test('메모와 태그로도 찾는다', () => {
  assert.deepEqual(find('수민'), ['t3']);
  assert.deepEqual(find('제주'), ['t3']);
  assert.deepEqual(find('#모임'.slice(1)), ['t3']);
});

test('금액은 쉼표를 쳐도 안 쳐도 같다', () => {
  assert.deepEqual(find('47000'), ['t3']);
  assert.deepEqual(find('47,000'), ['t3']);
  assert.deepEqual(find('12000'), ['t1']);
});

test('낱말을 여럿 치면 모두 맞아야 한다', () => {
  assert.deepEqual(find('발산 카페'), ['t2'], '좁힐수록 쓸모 있다');
  assert.deepEqual(find('발산 의료'), []);
});

test('대소문자와 띄어쓰기는 무시한다', () => {
  assert.deepEqual(find('현대 이마트plus'), ['t1']);
  assert.deepEqual(find('현대이마트Plus'), ['t1']);
});

test('날짜로도 찾는다', () => {
  assert.deepEqual(find('2026-09-15'), ['t3']);
});

test('취소 문자는 찾기에 안 나온다', () => {
  assert.deepEqual(find('1800'), ['t2'], '없던 일이 된 건은 내역이 아니다');
});

test('최근 것부터 나온다', () => {
  assert.deepEqual(find('발산'), ['t2', 't3']);
});

test('빈 검색어는 아무것도 안 준다', () => {
  assert.deepEqual(find(''), [], '전부 내놓으면 찾은 게 아니다');
  assert.deepEqual(terms('  '), []);
});

test('태그를 많이 쓴 순으로 모은다', () => {
  const more = [...TXNS, { id: 't4', tags: ['모임'] }];
  assert.deepEqual(knownTags(more).map((t) => t.name), ['모임', '2026제주', '출근길']);
});

test('태그는 쉼표로 나누고 겹치면 하나만 둔다', () => {
  assert.deepEqual(parseTags('제주, 여행 ,#제주,'), ['제주', '여행']);
  assert.deepEqual(parseTags(''), []);
});

// ───────────────────────────────────────────────── 내보내기

test('내보낸 표에 머리글과 줄이 다 있다', () => {
  const csv = toCSV(TXNS, { categories: CATS, accounts: [] });
  const lines = csv.replace('﻿', '').split('\r\n');
  assert.equal(lines[0], HEADERS.join(','));
  assert.equal(lines.length, TXNS.length + 1);
});

test('하위 칸이면 큰 갈래도 함께 적는다', () => {
  const csv = toCSV([TXNS[1]], { categories: CATS });
  assert.ok(csv.includes('카페,식비'), '다른 데서도 갈래로 묶을 수 있어야 한다');
});

test('옛 날짜부터 적는다', () => {
  const csv = toCSV(TXNS, { categories: CATS });
  const first = csv.split('\r\n')[1];
  assert.ok(first.startsWith('2026-09-11'));
});

test('쉼표와 따옴표가 든 글자는 감싼다', () => {
  const csv = toCSV([{ id: 'x', type: 'expense', amount: 1, occurredAt: '2026-09-01T00:00:00',
    merchantRaw: '가게, "진짜"' }], { categories: [] });
  assert.ok(csv.includes('"가게, ""진짜"""'), '안 감싸면 칸이 밀린다');
});

test('엑셀이 한글을 안 깨뜨리게 BOM 을 붙인다', () => {
  assert.ok(toCSV([], {}).startsWith('﻿'));
});
