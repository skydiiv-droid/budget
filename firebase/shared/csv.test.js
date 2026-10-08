import test from 'node:test';
import assert from 'node:assert/strict';
import { toCSV, HEADERS } from './csv.js';

test('머리글과 줄 수가 맞는다', () => {
  const csv = toCSV([
    { id: 't1', type: 'expense', amount: 1_800, occurredAt: '2026-09-19T19:14:00',
      merchantRaw: '컴포즈커피', categoryId: 'cat_cafe', cardName: '현대 미래에셋' },
    { id: 't2', type: 'income', amount: 2_600_000, occurredAt: '2026-09-05T09:00:00',
      merchantRaw: '급여', categoryId: 'cat_salary' },
  ], { categories: [{ id: 'cat_cafe', name: '카페', parentId: 'cat_food' },
                    { id: 'cat_food', name: '식비' },
                    { id: 'cat_salary', name: '급여' }] });
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].endsWith(HEADERS[HEADERS.length - 1]));
  assert.ok(lines[1].includes('급여'), '오래된 것이 먼저 온다');
  assert.ok(lines[2].includes('카페') && lines[2].includes('식비'));
});

test('엑셀이 한글을 깨뜨리지 않게 BOM 을 붙인다', () => {
  assert.ok(toCSV([]).startsWith('﻿'));
});

test('쉼표가 든 가게 이름은 감싼다', () => {
  const csv = toCSV([{ id: 't1', type: 'expense', amount: 1_000,
    occurredAt: '2026-09-01T10:00:00', merchantRaw: '김밥, 천국' }]);
  assert.ok(csv.includes('"김밥, 천국"'));
});

test('나눠 둔 결제는 조각마다 한 줄로 내보낸다', () => {
  const csv = toCSV([{ id: 't1', type: 'expense', amount: 20_000,
    occurredAt: '2026-09-10T12:00:00', merchantRaw: '이마트', categoryId: 'cat_grocery',
    splits: [{ categoryId: 'cat_hobby', amount: 5_000 }] }], {
    categories: [{ id: 'cat_grocery', name: '마트' }, { id: 'cat_hobby', name: '취미' }],
  });
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 3, '머리글 + 조각 둘');
  assert.ok(lines[1].includes('5000') && lines[1].includes('취미'));
  assert.ok(lines[2].includes('15000') && lines[2].includes('마트'));
  assert.ok(lines[1].endsWith('1/2') && lines[2].endsWith('2/2'), '몇 번째 조각인지 적는다');
  // 금액 합은 그대로다 — 표 계산기에서 더해도 2만원이다
  const sum = lines.slice(1).map((l) => Number(l.split(',')[3])).reduce((a, b) => a + b, 0);
  assert.equal(sum, 20_000);
});
