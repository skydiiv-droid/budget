/**
 * 적금에 넣은 돈이 지출로 세어지던 것.
 *
 * 고치는 길(저축투자 카테고리)은 있었는데 그 길로 고쳐도 숫자가 안 바뀌었다.
 * 고칠 수 있는 줄 알았는데 안 고쳐지는 건 아예 없는 것보다 나쁘다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { transferCats, isMoved, looksLikeSaving } from './categories.js';
import { monthSpending, breakdown, ledger } from './ledger.js';
import { shiftStats } from './shifts.js';

const CATS = [
  { id: 'cat_cafe', name: '카페', kind: 'expense' },
  { id: 'cat_saving', name: '저축투자', kind: 'transfer' },
  { id: 'cat_cardbill', name: '카드대금', kind: 'transfer' },
];
const SETTINGS = { cycleStartDay: 1, monthlyIncome: 3_000_000, variableBudget: 900_000 };
const NOW = new Date('2026-09-21T10:00:00');

const spend = (id, amount, categoryId, at = '2026-09-10T10:00:00') =>
  ({ id, type: 'expense', amount, occurredAt: at, categoryId, merchantRaw: `가맹점${id}` });

test('이체 성격 카테고리를 추려낸다', () => {
  const moved = transferCats(CATS);
  assert.equal(moved.has('cat_saving'), true);
  assert.equal(moved.has('cat_cardbill'), true);
  assert.equal(moved.has('cat_cafe'), false);
  assert.equal(transferCats().size, 0);
});

test('문자에서 바로 알아본 것도, 사람이 고친 것도 똑같이 옮긴 돈이다', () => {
  const moved = transferCats(CATS);
  assert.equal(isMoved({ type: 'transfer' }, moved), true, '종류로 잡힌 것');
  assert.equal(isMoved({ type: 'expense', categoryId: 'cat_saving' }, moved), true, '사람이 고친 것');
  assert.equal(isMoved({ type: 'expense', categoryId: 'cat_cafe' }, moved), false);
  assert.equal(isMoved(null, moved), false);
  assert.equal(isMoved({ type: 'expense', categoryId: 'cat_saving' }), false, '카테고리를 안 주면 모른다');
});

test('저축투자로 바꾸면 지출에서 빠진다 — 이게 안 되던 것이다', () => {
  const transactions = [
    spend('a', 30_000, 'cat_cafe'),
    spend('b', 500_000, 'cat_saving'),           // 적금에 넣은 돈
  ];
  const rows = monthSpending({ transactions, settings: SETTINGS, categories: CATS }, '2026-09', NOW);
  const total = rows.reduce((s, r) => s + (r.counted ? r.net : 0), 0);
  assert.equal(total, 30_000, '적금 50만은 쓴 돈이 아니다');

  const saved = rows.find((r) => r.id === 'b');
  assert.equal(saved.moved, true);
  assert.equal(saved.counted, false);
  assert.ok(saved, '목록에서는 사라지지 않는다 — 옮겼다는 것도 봐야 한다');
});

test('카테고리를 안 넘기면 예전처럼 다 센다 — 넘기는 걸 빠뜨리면 바로 티가 난다', () => {
  const transactions = [spend('b', 500_000, 'cat_saving')];
  const rows = monthSpending({ transactions, settings: SETTINGS }, '2026-09', NOW);
  assert.equal(rows[0].counted, true);
});

test('카테고리 그림에서도 빠진다', () => {
  const transactions = [spend('a', 30_000, 'cat_cafe'), spend('b', 500_000, 'cat_saving')];
  const rows = monthSpending({ transactions, settings: SETTINGS, categories: CATS }, '2026-09', NOW);
  const b = breakdown(rows, CATS);
  assert.equal(b.total, 30_000);
  assert.ok(!b.items.some((i) => i.id === 'cat_saving'));
  assert.equal(b.skipped, 0, '"분석에서 뺐다"와는 다른 일이다 — 총액에도 없다');
});

test('근무별 평균에서도 빠진다', () => {
  const transactions = [
    spend('a', 30_000, 'cat_cafe', '2026-09-10T14:00:00'),
    spend('b', 500_000, 'cat_saving', '2026-09-10T15:00:00'),
  ];
  const shifts = { '2026-09-10': 'day' };
  const s = shiftStats({ transactions, shifts, categories: CATS });
  const day = s.items.find((i) => i.id === 'day');
  assert.equal(day.total, 30_000, '적금 넣은 날이라고 그날 50만원 쓴 게 아니다');
});

test('예산과 여력에서도 빠진다', () => {
  const transactions = [spend('b', 500_000, 'cat_saving')];
  const L = ledger({ transactions, categories: CATS, settings: SETTINGS }, '2026-09', NOW);
  assert.equal(L.actual.variable, 0);
  assert.equal(L.budget.spent, 0);
  assert.equal(L.budget.usedPct, 0);
});

test('저축으로 보이는 말', () => {
  for (const w of ['청약저축', '우리적금', '정기예금', '연금저축', 'ISA계좌', '미래에셋증권']) {
    assert.equal(looksLikeSaving(w), true, w);
  }
  // 애매한 건 짐작하지 않는다 — 지인에게 보낸 돈일 수 있다
  for (const w of ['계좌이체', '송금', '김철수', 'GS25']) {
    assert.equal(looksLikeSaving(w), false, w);
  }
});
