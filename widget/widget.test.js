/**
 * 위젯이 무엇을 그리는지 본다.
 *
 * 위젯은 아이폰에서만 도는데, 거기서 처음 돌려 보면 빈 화면이나 한 줄짜리
 * 에러를 본다. 무엇이 그려지는지를 글자로 뽑으면 숫자가 맞는지 · 칸이 비지
 * 않는지 · 어느 크기가 통째로 빠졌는지까지는 여기서 잡힌다.
 *
 * 그림 자체(줄 간격 · 잘림)는 여전히 실제 기기에서 봐야 한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { install, dump } from './scriptable-stub.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const DATA = {
  ok: true, month: '2026-09',
  spent: 581_350, budget: 900_000, perDay: 33_565, daysLeft: 10,
  usedPct: 63, projected: 894_306, dayOf: 20, days: 30, dailyAvg: 29_068,
  enoughForPace: true,          // 20/30일 — 예상을 걸 만큼은 지났다
  lastMonthSameSpan: 395_000, debt: 3_580_000,
  goalPct: 15, goalName: '빚 정리',
  nextBill: { name: '현대 이마트Plus', total: 820_605, payAt: '2026-10-12', daysLeft: 22 },
  billTotal: 820_605, waiting: 3,
  top: [
    { id: 'cat_food', name: '식비', icon: '🍚', amount: 133_800, pct: 24, count: 9 },
    { id: 'cat_event', name: '경조사', icon: '🎁', amount: 100_000, pct: 18, count: 1 },
    { id: 'cat_shopping', name: '쇼핑', icon: '🛍️', amount: 89_300, pct: 16, count: 1 },
  ],
};

const source = (file) => readFileSync(join(HERE, file), 'utf8')
  .replace(/const TOKEN = .*/, "const TOKEN = 'x';")
  .replace(/const URL = .*/, "const URL = 'x';");

async function draw(family, data = DATA) {
  globalThis.__DATA = data;
  const { root } = install(family);
  const src = `${source('budget-widget.js')}\n// ${family}-${Math.random()}`;
  await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
  return dump(root).join('\n');
}

test('큰 위젯은 총액 · 예산 · 하루 평균 · 예상 · 카테고리를 다 그린다', async () => {
  const out = await draw('large');
  assert.match(out, /이번 달 지출/);
  assert.match(out, /₩581,350/);
  assert.match(out, /20\/30일/);
  assert.match(out, /예산 ₩900,000 중 63%/);
  assert.match(out, /하루 평균/);
  assert.match(out, /₩29,068/);
  assert.match(out, /이번 달 예상/);
  assert.match(out, /₩894,306/);
  assert.match(out, /예산 ₩5,694 미만 예상/);
  assert.match(out, /카테고리별 지출/);
  assert.match(out, /🍚 식비/);
  assert.match(out, /🎁 경조사/);
  assert.match(out, /🛍️ 쇼핑/);
});

test('큰 위젯은 갈래를 셋까지만 그린다', async () => {
  const many = { ...DATA, top: [...DATA.top, { id: 'x', name: '교통', icon: '🚌', amount: 1, pct: 1 }] };
  const out = await draw('large', many);
  assert.ok(!out.includes('교통'), 'summary 가 더 줘도 자리가 셋뿐이다');
});

test('예산을 안 잡았으면 예산 줄을 그리지 않는다', async () => {
  const out = await draw('large', { ...DATA, budget: 0 });
  assert.ok(!out.includes('예산'), '없는 기준에 견주는 말을 하면 안 된다');
  assert.match(out, /₩581,350/, '쓴 돈은 그대로 보인다');
});

test('예산을 넘기면 넘긴 만큼을 말한다', async () => {
  const out = await draw('large', { ...DATA, spent: 1_000_000, usedPct: 111, projected: 1_400_000 });
  assert.match(out, /₩100,000 초과/);
  assert.match(out, /예산 ₩500,000 초과 예상/);
});

test('어느 크기도 빈 화면이 되지 않는다', async () => {
  for (const family of ['large', 'medium', 'small',
                        'accessoryRectangular', 'accessoryCircular', 'accessoryInline']) {
    const out = await draw(family);
    assert.ok(out.trim().length > 0, `${family} 가 비어 있다`);
    assert.ok(!out.includes('불러오지 못했어요'), `${family} 가 에러로 떨어진다`);
  }
});

test('못 불러오면 무엇이 문제인지 적는다', async () => {
  globalThis.__DATA = { ok: false, reason: 'unauthorized', message: '토큰이 맞지 않습니다' };
  const { root } = install('large');
  const src = `${source('budget-widget.js')}\n// err-${Math.random()}`;
  await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
  const out = dump(root).join('\n');
  assert.match(out, /불러오지 못했습니다/);
  assert.match(out, /토큰이 맞지 않습니다/, '빈 화면만 보면 뭘 고쳐야 할지 모른다');
});

test('좁은 자리 숫자는 만 단위로 끊는다', async () => {
  const out = await draw('medium');
  assert.match(out, /18\.6만|19만/, '"186천" 은 한국어가 아니다');
});

// ───────────────────────────────────────────────── 어느 테마에서도 보이게

/** 그려진 글자마다 어떤 색이 쓰였는지 모은다. */
function colorsIn(node, out = []) {
  for (const c of node.children) {
    if (c.kind === 'text') out.push({ text: c.text, color: c.color });
    else colorsIn(c, out);
  }
  return out;
}

async function paint(family) {
  globalThis.__DATA = DATA;
  const { root } = install(family);
  const src = `${source('budget-widget.js')}\n// paint-${family}-${Math.random()}`;
  await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
  return root;
}

test('글자색이 두 테마를 다 들고 있다', async () => {
  const flat = [];
  for (const family of ['large', 'medium', 'small']) {
    for (const t of colorsIn(await paint(family))) {
      if (!t.color) { flat.push(`${family}: "${t.text}" 색이 없음`); continue; }
      if (!t.color.dynamic) flat.push(`${family}: "${t.text}" ${t.color.hex}`);
    }
  }
  assert.deepEqual(flat, [],
    '한 벌만 박으면 반대 테마에서 어두운 바탕에 어두운 글자가 된다');
});

test('홈 화면 위젯에는 바탕을 깐다', async () => {
  for (const family of ['large', 'medium', 'small']) {
    const root = await paint(family);
    assert.ok(root.props.bg?.dynamic, `${family} 에 바탕이 없다 — 대비를 장담할 수 없다`);
  }
});

test('잠금화면 위젯에는 바탕을 깔지 않는다', async () => {
  for (const family of ['accessoryRectangular', 'accessoryCircular', 'accessoryInline']) {
    const root = await paint(family);
    assert.ok(!root.props.bg, `${family} 에 바탕을 주면 네모 상자가 생긴다`);
  }
});

test('막대 바탕도 테마를 따라간다', async () => {
  const root = await paint('large');
  const bars = [];
  const walk = (n) => {
    if (n.props?.bg && n.props?.size) bars.push(n.props.bg);
    n.children.forEach(walk);
  };
  walk(root);
  assert.ok(bars.length >= 2, '막대를 못 찾았다 — 검사가 헛돌고 있다');
  assert.ok(bars.every((b) => b.dynamic), '트랙이 밝은 회색 하나면 다크에서 허옇게 뜬다');
});

test('달 초에는 예상을 걸지 않는다', async () => {
  // 이틀치로 한 달을 점치면 숫자가 요동친다. 위젯이 그걸 그대로 띄우면
  // 매달 초마다 엉뚱한 숫자를 보게 된다.
  const out = await draw('large',
    { ...DATA, dayOf: 2, spent: 3_000, usedPct: 0, projected: 45_000, enoughForPace: false });
  assert.match(out, /이번 달 예상/, '자리는 남겨 둔다');
  assert.match(out, /아직 이르다/);
  assert.ok(!out.includes('₩45,000'), '점친 숫자를 띄우지 않는다');
  assert.ok(!out.includes('미만 예상') && !out.includes('초과 예상'),
    '예산에 견주는 말도 하지 않는다');
});
