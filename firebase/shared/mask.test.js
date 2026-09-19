/**
 * 가리기에 구멍이 나는지 본다.
 *
 * 금액을 흐리게 하는 건 CSS 가 하는데, 흐릴 대상을 class 로 고른다.
 * 새 화면을 그리면서 class 를 안 붙이면 그 숫자만 맨눈에 남는다 —
 * 병원에서 어깨너머로 보이지 말라고 만든 기능인데 한 줄이 새면 의미가 없다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const js = readFileSync(join(HERE, '..', 'public', 'app.js'), 'utf8');
const css = readFileSync(join(HERE, '..', 'public', 'app.css'), 'utf8');

const MASKED = ['num', 'big', 'tx-amt', 'brk-amt', 'day-sum', 'fold-s'];

test('가릴 class 가 CSS 에 다 들어 있다', () => {
  const rule = css.split('body.masked').slice(1).join(' ');
  for (const name of MASKED) {
    assert.ok(rule.includes(`.${name}`), `${name} 이 가리기 규칙에 없다`);
  }
});

test('금액을 찍는 자리마다 가릴 class 가 붙어 있다', () => {
  // ${won(...)} 이 들어간 조각을 훑어, 앞쪽 120자 안에 가릴 class 가 있는지 본다
  const leaks = [];
  const re = /\$\{won\(/g;
  let m;
  while ((m = re.exec(js))) {
    const before = js.slice(Math.max(0, m.index - 140), m.index);
    const lastTag = before.lastIndexOf('<');
    const chunk = lastTag >= 0 ? before.slice(lastTag) : before;
    if (MASKED.some((c) => chunk.includes(c))) continue;
    // 속성값에 들어가는 건 화면에 글자로 찍히지 않는다.
    // aria-label 은 읽어 주기용이라 눈에 안 보인다 — 어깨너머로 새지 않는다.
    if (/value="$|placeholder="$|data-[a-z]+="$|aria-label="[^"]*$/.test(before)) continue;
    // fold() 가 넘겨받은 요약은 .fold-s 안에 들어가고, 그건 가려진다
    if (/fold\('[a-z]+'/.test(before.slice(-160))) continue;
    // 토스트는 내가 방금 누른 것에 대한 대답이라 잠깐 뜨고 사라진다
    if (/toast\(`?[^`]*$/.test(before.slice(before.lastIndexOf('toast(')))
        && before.includes('toast(')) continue;
    leaks.push(js.slice(Math.max(0, m.index - 70), m.index + 40).replace(/\s+/g, ' '));
  }
  assert.deepEqual(leaks, [], '가려지지 않는 금액이 화면에 남는다');
});
