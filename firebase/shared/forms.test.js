/**
 * 폼 안에서 이름이 겹치는지 본다.
 *
 * 같은 name 을 둘 두면 form.elements.x 가 하나가 아니라 목록이 되고, 읽을 때는
 * 숨어 있는 쪽 값이 잡히기도 한다. 두 번 겪었다 — "어디로" 칸과 이자율 칸.
 * 눈에 띄는 증상이 "칸이 안 눌린다" 정도라 찾는 데 오래 걸린다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const sources = ['app.js', 'index.html'].map((f) => readFileSync(join(PUBLIC, f), 'utf8'));

/** `<form data-form="x">` 부터 `</form>` 까지를 한 덩어리로 본다. */
function forms(text) {
  const out = [];
  const re = /<form[^>]*data-(?:form|txn|raw)="([^"]+)"[\s\S]*?<\/form>/g;
  let m;
  while ((m = re.exec(text))) out.push([m[1], m[0]]);
  return out;
}

test('한 폼 안에서 name 이 겹치지 않는다', () => {
  const dupes = [];
  for (const text of sources) {
    for (const [key, html] of forms(text)) {
      const names = [...html.matchAll(/\sname="([^"]+)"/g)].map((m) => m[1]);
      const seen = new Set();
      for (const n of names) {
        // 라디오 버튼은 일부러 이름을 나눠 쓴다 — 지금은 안 쓰지만 열어 둔다
        if (/type="radio"/.test(html) && html.includes(`type="radio" name="${n}"`)) continue;
        if (seen.has(n)) dupes.push(`${key}.${n}`);
        seen.add(n);
      }
    }
  }
  assert.deepEqual([...new Set(dupes)], [],
    '같은 이름이 둘이면 숨은 쪽 값이 잡히기도 한다');
});

test('폼을 실제로 찾아내고 있다', () => {
  const found = sources.flatMap(forms).map(([k]) => k);
  assert.ok(found.length >= 8, `폼을 ${found.length}개밖에 못 찾았다 — 검사가 헛돌고 있다`);
  assert.ok(found.includes('accounts') && found.includes('quick'));
});
