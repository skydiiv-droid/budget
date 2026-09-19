/**
 * 화면에서 쓰는 색 이름이 실제로 정의돼 있는지 본다.
 *
 * 팔레트를 갈아엎으면서 var(--debt) 를 열세 군데 남겼다. 없는 이름을 쓰면
 * 브라우저는 조용히 무시하고 글자를 검정으로 그린다 — 빨간 숫자가 검게
 * 나오는데 아무 데서도 에러가 나지 않는다. 그래서 여기서 잡는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const css = readFileSync(join(PUBLIC, 'app.css'), 'utf8');

// :root 말고 화면을 그리면서 style="--h:122px" 처럼 그 자리에서 정하는 것도 있다
const js0 = readFileSync(join(PUBLIC, 'app.js'), 'utf8');
const defined = new Set([
  ...[...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
  ...[...js0.matchAll(/style="(--[a-z0-9-]+):/g)].map((m) => m[1]),
]);

test('색 이름을 정의 없이 쓰지 않는다', () => {
  const missing = new Map();
  for (const file of readdirSync(PUBLIC).filter((f) => /\.(js|css|html)$/.test(f))) {
    const text = readFileSync(join(PUBLIC, file), 'utf8');
    for (const m of text.matchAll(/var\((--[a-z0-9-]+)\)/g)) {
      if (defined.has(m[1])) continue;
      missing.set(`${file} ${m[1]}`, (missing.get(`${file} ${m[1]}`) || 0) + 1);
    }
  }
  assert.deepEqual([...missing.keys()], [],
    '없는 이름은 조용히 무시돼 글자가 검정으로 나온다');
});

test('팔레트가 비어 있지 않다', () => {
  for (const name of ['--blue', '--spend', '--ink', '--ground', '--line']) {
    assert.ok(defined.has(name), `${name} 이 없다`);
  }
});
