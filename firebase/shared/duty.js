/**
 * 근무표 앱에서 듀티를 읽어 온다.
 *
 * 근무표는 따로 만든 앱(Firebase 실시간 데이터베이스)에 이미 들어 있다.
 * 같은 걸 가계부에 또 손으로 치는 건 낭비다 — 한 달에 서른 글자씩, 매달.
 *
 * **저장 구조를 모른 채로 읽는다.** 그쪽 앱이 어떤 모양으로 넣어 뒀는지
 * 알 수 없고, 나중에 바뀔 수도 있다. 그래서 경로를 못 박지 않고 나무를 훑어
 * **듀티처럼 생긴 값**을 찾은 다음, 그 위에 있던 키에서 사람과 달을 읽는다.
 *
 * 두 가지 모양을 다 받는다.
 *
 *   한 달치 한 줄   { "홍길동": { "2026-09": "OOOEODD..." } }
 *   하루 한 글자    { "홍길동": { "2026-09-01": "O", … } }
 *   하루가 객체      { duties: { "2026-09": { "224051": { "01": { shift:"D", team:"A" } } } } }
 *
 * 마지막 모양이 실제로 쓰는 것이다. 사람이 **사번**이라 키가 숫자인데, 날짜도
 * 숫자라 둘을 갈라야 한다 — 1~31 은 날짜고 그보다 긴 숫자는 사람이다.
 *
 * 읽기만 한다. 근무표 앱에는 아무것도 쓰지 않는다.
 */

import { parseShiftText } from './shifts.js';

/** 듀티 글자. 한글로 적어 뒀어도 알아본다. */
const LETTERS = 'DENOXdenox데이나오휴';
const ONLY_DUTY = new RegExp(`^[${LETTERS}\\s,·\\-/]+$`);
const letters = (s) => [...String(s ?? '')].filter((c) => LETTERS.includes(c)).length;

/** 사람 이름이 아니라 그릇 이름인 키. 이런 건 사람으로 보지 않는다. */
const CONTAINER = new Set([
  'users', 'user', 'shifts', 'shift', 'duties', 'duty', 'schedule', 'schedules',
  'months', 'month', 'days', 'day', 'data', 'value', 'values', 'list', 'items',
  'calendar', 'roster', 'table', 'staff', 'members', 'nurses', 'team',
  '근무', '근무표', '듀티', '스케줄', '달력',
]);

const MONTH = /(20\d{2})[-_/.]?(0[1-9]|1[0-2])(?![0-9])/;
const DATE = /(20\d{2})[-_/.]?(0[1-9]|1[0-2])[-_/.]?(0[1-9]|[12]\d|3[01])(?![0-9])/;

/** 키나 값에서 `2026-09` 를 뽑아낸다. */
export function monthOf(key) {
  const m = MONTH.exec(String(key ?? ''));
  return m ? `${m[1]}-${m[2]}` : '';
}

/** 키에서 날짜를 뽑아낸다. `2026-09-01` 또는 그냥 `1` ~ `31`. */
function dayOf(key, month) {
  const text = String(key ?? '');
  const d = DATE.exec(text);
  if (d) return `${d[1]}-${d[2]}` === month ? Number(d[3]) : 0;
  const n = /^\s*(\d{1,2})\s*(일)?\s*$/.exec(text);
  return n ? Number(n[1]) : 0;
}

/** 한 달치를 한 줄로 적어 둔 값인가. 며칠치는 돼야 근무표로 본다. */
const looksLikeMonth = (v) => typeof v === 'string'
  && ONLY_DUTY.test(v) && letters(v) >= 20;

/** 하루치 값이 싸여 있을 때 듀티가 들어 있는 칸. */
const SHIFT_FIELDS = ['shift', 'duty', 'type', 'code', 'kind', 'value', '근무'];

/**
 * 하루치 값에서 글자 하나를 꺼낸다.
 *
 * 그냥 "D" 로 적어 두기도 하고 `{ shift:"D", team:"A" }` 처럼 싸 두기도 한다.
 * 못 꺼내면 빈 글자 — 그 날은 근무가 없는 것으로 본다.
 */
function dayLetter(value) {
  const pick = (v) => {
    if (typeof v !== 'string') return '';
    const t = v.trim();
    return t.length > 0 && t.length <= 2 && letters(t) === t.length ? t : '';
  };
  if (typeof value === 'string') return pick(value);
  if (!value || typeof value !== 'object') return '';
  for (const field of SHIFT_FIELDS) {
    const got = pick(value[field]);
    if (got) return got;
  }
  return '';
}

/**
 * 나무를 훑어 근무표를 다 찾는다.
 *
 * @returns [{ person, month, text, path }]  — text 는 1일부터 순서대로 이어 붙인 것
 */
export function findDuties(tree, opts = {}) {
  const { month: hintMonth = '', limit = 400 } = typeof opts === 'number' ? { limit: opts } : opts;
  const out = [];
  const seen = new Set();

  const push = (path, month, text) => {
    if (!month || letters(text) === 0) return;
    const person = personIn(path, tree);
    const key = `${person}\u0000${month}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ person, month, text, path: [...path] });
  };

  const walk = (node, path) => {
    if (out.length >= limit || path.length > 8) return;
    if (typeof node === 'string') {
      // 값 자체가 한 달치. 달은 경로에서 찾고, 없으면 주소에서 읽은 달을 쓴다.
      if (looksLikeMonth(node)) push(path, monthInPath(path) || hintMonth, node);
      return;
    }
    if (!node || typeof node !== 'object') return;

    // 하루 한 글자로 흩어 둔 모양인가
    const byDay = collectDays(node, path, hintMonth);
    for (const [month, text] of byDay) push([...path, month], month, text);

    for (const [key, value] of Object.entries(node)) walk(value, [...path, key]);
  };

  walk(tree, []);
  return out.sort((a, b) => a.person.localeCompare(b.person) || b.month.localeCompare(a.month));
}

/**
 * 이 객체가 날짜별로 듀티를 담고 있으면 달마다 한 줄로 이어 붙인다.
 *
 * 빠진 날은 `·` 로 메운다. 그래야 1일부터 세는 자리가 안 밀린다.
 */
function collectDays(node, path, hintMonth = '') {
  const months = new Map();
  const hint = monthInPath(path) || hintMonth;

  for (const [key, value] of Object.entries(node)) {
    const letter = dayLetter(value);
    if (!letter) continue;
    const month = monthOf(key) || hint;
    if (!month) continue;
    const day = dayOf(key, month);
    if (!day || day > 31) continue;
    if (!months.has(month)) months.set(month, new Map());
    months.get(month).set(day, letter);
  }

  const out = [];
  for (const [month, days] of months) {
    if (days.size < 5) continue;                 // 며칠짜리는 근무표가 아니다
    const last = Math.max(...days.keys());
    let text = '';
    for (let d = 1; d <= last; d++) text += days.get(d) || '·';
    out.push([month, text]);
  }
  return out;
}

const monthInPath = (path) => {
  for (let i = path.length - 1; i >= 0; i--) {
    const m = monthOf(path[i]);
    if (m) return m;
  }
  return '';
};

/** 1~31 은 날짜지 사람이 아니다. 사번처럼 더 긴 숫자는 사람이다. */
const isDayKey = (k) => /^\d{1,2}$/.test(k) && Number(k) >= 1 && Number(k) <= 31;
const isYearKey = (k) => /^(19|20)\d{2}$/.test(k);

/**
 * 이 경로가 누구 것인가.
 *
 * 경로 키 중에 달도 날짜도 그릇 이름도 아닌 것이 사람이다. 사번이면 숫자지만
 * 날짜보다 기니 갈린다. 그런 키가 없으면 그 자리 객체에 적힌 `name` 을 본다.
 */
export function personIn(path, tree) {
  for (let i = path.length - 1; i >= 0; i--) {
    const key = String(path[i]);
    if (monthOf(key) || isDayKey(key) || isYearKey(key) || CONTAINER.has(key.toLowerCase())) continue;
    const named = nameAt(tree, path.slice(0, i + 1));
    return named || key;
  }
  return '';
}

/** 그 자리 객체에 이름이 적혀 있으면 그걸 쓴다. */
function nameAt(tree, path) {
  let node = tree;
  for (const key of path) {
    if (!node || typeof node !== 'object') return '';
    node = node[key];
  }
  if (!node || typeof node !== 'object') return '';
  for (const field of ['name', 'displayName', 'nickname', '이름', '성명']) {
    if (typeof node[field] === 'string' && node[field].trim()) return node[field].trim();
  }
  return '';
}

/** 근무표에 들어 있는 사람들. 근무표가 많은 사람부터. */
export function dutyPeople(duties = []) {
  const count = new Map();
  for (const d of duties) count.set(d.person, (count.get(d.person) || 0) + 1);
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([person, months]) => ({ person, months }));
}

/** 그 사람 것만. 최근 달부터. */
export const dutiesOf = (duties = [], person) => duties
  .filter((d) => !person || d.person === person)
  .sort((a, b) => b.month.localeCompare(a.month));

/**
 * 가져온 한 줄을 가계부가 쓰는 날짜별 근무로 바꾼다.
 *
 * 글자 수가 그 달 날수와 안 맞으면 어딘가 밀린 것이므로 그대로 받지 않고
 * 얼마나 어긋났는지 함께 돌려준다. 하루라도 밀리면 근무별 지출이 통째로
 * 틀리는데, 틀린 줄을 모르는 게 제일 나쁘다.
 */
export function toShifts(month, text) {
  const [y, m] = String(month).split('-').map(Number);
  const last = y && m ? new Date(y, m, 0).getDate() : 31;
  const days = parseShiftText(text, month);
  const filled = letters(text);
  return {
    month, days,
    count: Object.keys(days).length,
    last,
    // 다 채워졌는가. 모자라면 뒷날이 비고, 넘치면 잘린다.
    ok: filled === last,
    filled,
  };
}

/**
 * 읽을 주소를 만든다. 읽기 전용 REST 주소다.
 *
 * 맨 위(`…app`)를 넣으면 데이터베이스 전체를 받는다. 사람이 여럿이고 달이
 * 쌓이면 그게 다 딸려 오므로, `…/duties/2026-09` 처럼 좁혀 넣어도 되게 했다.
 */
export function dutyEndpoint(url) {
  const base = String(url || '').trim().replace(/\/+$/, '').replace(/\.json$/, '');
  return /^https:\/\/[^\s]+$/.test(base) ? `${base}/.json` : '';
}

/** 주소에 달이 적혀 있으면 (`…/duties/2026-09`) 그걸 힌트로 쓴다. */
export const monthInUrl = (url) => monthOf(String(url || '').split('?')[0]);
