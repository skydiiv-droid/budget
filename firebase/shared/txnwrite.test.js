/**
 * 거래를 고치는 곳은 창 밖 거래 캐시를 버려야 한다.
 *
 * 전체를 한 번 읽고 나면 창(열세 달) 밖의 거래는 다시 안 읽고 들고 간다.
 * 매번 다시 받으면 무엇을 누르든 몇 초씩 걸리기 때문이다. 대신 그 옛 거래를
 * 고치는 곳에서 `dropOlder()` 를 안 부르면 화면에 **옛 값이 그대로 남는다**.
 *
 * 고쳤는데 안 고쳐진 것처럼 보이는 건 못 고치는 것보다 나쁘다. 그래서 새로
 * 거래를 건드리는 코드를 넣을 때 빠뜨리지 않게 여기서 잡는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const APP = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');

/**
 * 거래를 **고치는** 줄. 새로 만드는 건(`doc(col('txns'))`) 늘 최근이라 뺀다.
 */
// `b.update(doc(col('txns'), …))` 와 `updateDoc(doc(col('txns'), …))` 둘 다 쓴다.
// 처음엔 앞쪽만 찾다가 updateDoc 세 군데를 통째로 놓쳤다.
const WRITES = /\b(update|delete|set)(Doc)?\(\s*doc\(col\('txns'\)/;

/**
 * 함수 단위로 자르려다 한 번 헛돌았다 — submit 처리기가 한 덩어리라
 * 다른 가지의 `dropOlder()` 가 검사를 통과시켜 줬다. 그래서 **가까운 줄**을 본다.
 */
const NEAR = 25;

function writeLines(text) {
  const lines = text.split('\n');
  const out = [];
  lines.forEach((line, i) => {
    if (!WRITES.test(line)) return;
    const near = lines.slice(Math.max(0, i - NEAR), i + NEAR + 1).join('\n');
    out.push({ line: i + 1, code: line.trim(), guarded: near.includes('dropOlder()') });
  });
  return out;
}

test('거래를 고치는 곳은 창 밖 캐시를 버린다', () => {
  const missing = writeLines(APP)
    .filter((w) => !w.guarded)
    .map((w) => `줄 ${w.line}: ${w.code}`);
  assert.deepEqual(missing, [],
    '가까운 곳에서 dropOlder() 를 안 부르면 고친 옛 거래가 옛 값으로 남는다');
});

test('검사가 헛돌고 있지 않다', () => {
  const writing = writeLines(APP);
  assert.ok(writing.length >= 12,
    `거래를 고치는 곳을 ${writing.length}줄밖에 못 찾았다 — 찾는 규칙이 안 맞는다`);
  assert.ok(APP.includes('const dropOlder = ()'), 'dropOlder 가 있어야 한다');
});

test('창 밖 거래는 한 번만 읽는다', () => {
  // 매번 다시 읽으면 캐시를 둔 뜻이 없다
  assert.match(APP, /wantAll && !olderTxns/,
    '이미 읽어 둔 게 있으면 다시 받지 않아야 한다');
});
