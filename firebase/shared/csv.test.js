import test from 'node:test';
import assert from 'node:assert/strict';
import { toCSV, HEADERS, fromCSV, splitRow, csvKey } from './csv.js';

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
  assert.ok(lines[1].includes(',1/2,') && lines[2].includes(',2/2,'), '몇 번째 조각인지 적는다');
  // 금액 합은 그대로다 — 표 계산기에서 더해도 2만원이다
  const sum = lines.slice(1).map((l) => Number(l.split(',')[3])).reduce((a, b) => a + b, 0);
  assert.equal(sum, 20_000);
});

test('해외 결제는 외화 원금도 남긴다', () => {
  const csv = toCSV([{ id: 't1', type: 'expense', amount: 13_500,
    occurredAt: '2026-10-09T02:11:00', merchantRaw: 'APPLE.COM/BILL',
    fxCurrency: 'USD', fxAmount: 9.99 }]);
  assert.ok(csv.includes('USD 9.99'), '원화만 남기면 왜 그 금액인지 알 수 없다');
});

// ── 되읽기 ───────────────────────────────────────────────
// 내보내기만 있고 들이는 길이 없으면 그 파일은 종이 쪼가리다.

const CATS = [{ id: 'cat_cafe', name: '카페', parentId: 'cat_food' },
               { id: 'cat_food', name: '식비' },
               { id: 'cat_hobby', name: '취미' },
               { id: 'cat_grocery', name: '마트', parentId: 'cat_food' }];
const ACCS = [{ id: 'acc_a', name: '현대 미래에셋' }];

test('내보낸 것을 그대로 되읽는다', () => {
  const txns = [
    { id: 't1', type: 'expense', amount: 1_800, occurredAt: '2026-09-19T19:14:00',
      merchantRaw: '컴포즈커피', categoryId: 'cat_cafe', accountId: 'acc_a',
      tags: ['모임'], memo: '수민이랑', excludeFromBudget: false, status: 'confirmed' },
    { id: 't2', type: 'income', amount: 2_600_000, occurredAt: '2026-09-05T09:00:00',
      merchantRaw: '급여', categoryId: '', status: 'confirmed' },
  ];
  const { rows, skipped } = fromCSV(toCSV(txns, { categories: CATS, accounts: ACCS }),
    { categories: CATS, accounts: ACCS });
  assert.equal(skipped, 0);
  assert.equal(rows.length, 2);
  const cafe = rows.find((r) => r.merchantRaw === '컴포즈커피');
  assert.equal(cafe.amount, 1_800);
  assert.equal(cafe.occurredAt, '2026-09-19T19:14:00');
  assert.equal(cafe.categoryId, 'cat_cafe', '이름으로 id 를 되찾는다');
  assert.equal(cafe.accountId, 'acc_a');
  assert.deepEqual(cafe.tags, ['모임']);
  assert.equal(cafe.memo, '수민이랑');
  assert.equal(rows.find((r) => r.merchantRaw === '급여').type, 'income');
});

test('나눠 둔 거래는 한 건으로 되묶는다', () => {
  // 안 묶으면 거래가 둘로 늘어나고 카드사 누적에 없던 빵꾸가 생긴다
  const txns = [{ id: 't1', type: 'expense', amount: 20_000,
    occurredAt: '2026-09-19T18:00:00', merchantRaw: '이마트', categoryId: 'cat_grocery',
    accountId: 'acc_a', splits: [{ categoryId: 'cat_hobby', amount: 5_000 }] }];
  const { rows } = fromCSV(toCSV(txns, { categories: CATS, accounts: ACCS }),
    { categories: CATS, accounts: ACCS });
  assert.equal(rows.length, 1, '두 줄이지만 거래는 하나다');
  assert.equal(rows[0].amount, 20_000);
  assert.equal(rows[0].categoryId, 'cat_grocery', '큰 조각이 대표 카테고리다');
  assert.deepEqual([...rows[0].splits].sort((a, b) => a.amount - b.amount),
    [{ categoryId: 'cat_hobby', amount: 5_000 }, { categoryId: 'cat_grocery', amount: 15_000 }]
      .sort((a, b) => a.amount - b.amount));
});

test('칸이 늘어나도 머리글 이름으로 찾는다', () => {
  // 자리로 찾으면 「분할」·「외화」를 더한 판에서 전부 어긋난다
  const csv = '날짜,금액,가게\n2026-09-19,1800,컴포즈커피';
  const { rows } = fromCSV(csv, { categories: CATS });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 1_800);
  assert.equal(rows[0].occurredAt, '2026-09-19T12:00:00', '시각이 없으면 정오로 둔다');
});

test('날짜나 금액이 없는 줄은 세어서 알려 준다', () => {
  const csv = '날짜,금액,가게\n2026-09-19,1800,커피\n,5000,없는날짜\n2026-09-20,,없는금액\n헛소리';
  const { rows, skipped } = fromCSV(csv);
  assert.equal(rows.length, 1);
  assert.equal(skipped, 3, '조용히 버리면 몇 건이 빠졌는지 아무도 모른다');
});

test('머리글이 아니면 아무것도 들이지 않는다', () => {
  const { rows, note } = fromCSV('이건,그냥,글이다\n1,2,3');
  assert.deepEqual(rows, []);
  assert.ok(note.includes('날짜'));
});

test('쉼표가 든 가맹점도 되읽는다', () => {
  assert.deepEqual(splitRow('2026-09-19,1800,"김밥, 천국",카페'),
    ['2026-09-19', '1800', '김밥, 천국', '카페']);
});

test('같은 거래를 두 번 들이지 않도록 열쇠를 만든다', () => {
  const a = { occurredAt: '2026-09-19T19:14:00', amount: 1_800, merchantRaw: '컴포즈커피' };
  const b = { occurredAt: '2026-09-19T19:14:30', amount: 1_800, merchantRaw: '컴포즈커피' };
  assert.equal(csvKey(a), csvKey(b), '초는 보지 않는다');
  assert.notEqual(csvKey(a), csvKey({ ...a, amount: 1_900 }));
});
