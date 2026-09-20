/**
 * 근무표 앱의 저장 구조를 모르는 채로 읽어야 한다.
 * 그래서 있을 법한 모양을 여럿 놓고 다 읽히는지 본다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { findDuties, dutyPeople, dutiesOf, toShifts, monthOf, dutyEndpoint, personIn,
         monthInUrl } from './duty.js';

// 30일치 — 실제 근무표와 같은 모양의 가짜 값
const SEP = 'OOOEODDONNNODEOOENNNOOEEODDDOD';
const AUG = 'DDEENNOODDEENNOODDEENNOODDEENN0'.replace('0', 'O');

test('달을 여러 표기에서 읽는다', () => {
  assert.equal(monthOf('2026-09'), '2026-09');
  assert.equal(monthOf('202609'), '2026-09');
  assert.equal(monthOf('2026/09'), '2026-09');
  assert.equal(monthOf('shift_2026-09'), '2026-09');
  assert.equal(monthOf('2026-13'), '');
  assert.equal(monthOf('넷플릭스'), '');
});

test('사람 > 달 > 한 줄', () => {
  const tree = { 김간호: { '2026-09': SEP }, 이간호: { '2026-09': AUG } };
  const found = findDuties(tree);
  assert.equal(found.length, 2);
  const mine = dutiesOf(found, '김간호')[0];
  assert.equal(mine.month, '2026-09');
  assert.equal(mine.text, SEP);
});

test('shifts 같은 그릇 이름은 사람으로 보지 않는다', () => {
  const tree = { shifts: { 김간호: { '2026-09': SEP } } };
  assert.equal(findDuties(tree)[0].person, '김간호');
});

test('아이디로 갈라 두고 이름을 안에 적어도 읽는다', () => {
  const tree = {
    users: {
      uid_abc: { name: '김간호', shifts: { '2026-09': SEP } },
      uid_def: { name: '이간호', shifts: { '2026-09': AUG } },
    },
  };
  assert.deepEqual(dutyPeople(findDuties(tree)).map((p) => p.person).sort(), ['김간호', '이간호']);
});

test('달이 위에 있고 사람이 아래에 있어도 읽는다', () => {
  const tree = { '2026-09': { 김간호: SEP, 이간호: AUG } };
  const found = findDuties(tree);
  assert.equal(found.length, 2);
  assert.equal(dutiesOf(found, '김간호')[0].month, '2026-09');
});

test('하루 한 글자로 흩어 둔 것도 한 줄로 모은다', () => {
  const days = {};
  [...SEP].forEach((ch, i) => { days[`2026-09-${String(i + 1).padStart(2, '0')}`] = ch; });
  const found = findDuties({ 김간호: days });
  assert.equal(found.length, 1);
  assert.equal(found[0].text, SEP);
  assert.equal(found[0].month, '2026-09');
});

test('날짜 키가 그냥 1~31 이어도 위쪽 달을 빌려 쓴다', () => {
  const days = {};
  [...SEP].forEach((ch, i) => { days[String(i + 1)] = ch; });
  const found = findDuties({ 김간호: { '2026-09': days } });
  assert.equal(found[0].text, SEP);
});

test('빠진 날은 자리를 비워 둔다 — 안 그러면 뒷날이 통째로 밀린다', () => {
  const days = { 1: 'D', 2: 'D', 4: 'N', 5: 'N', 6: 'O', 7: 'O' };
  const found = findDuties({ 김간호: { '2026-09': days } });
  assert.equal(found[0].text, 'DD·NNOO');
});

test('듀티가 아닌 값은 줍지 않는다', () => {
  const tree = {
    김간호: { '2026-09': SEP, memo: '이번 달 힘들었다', phone: '01012345678' },
    설정: { theme: 'dark' },
  };
  const found = findDuties(tree);
  assert.equal(found.length, 1);
  assert.equal(found[0].text, SEP);
});

test('며칠짜리 짧은 글자는 근무표로 보지 않는다', () => {
  assert.deepEqual(findDuties({ 김간호: { '2026-09': 'DDEN' } }), []);
});

test('같은 사람 같은 달이 두 번 잡히지 않는다', () => {
  const tree = { 김간호: { shifts: { '2026-09': SEP }, duty: { '2026-09': SEP } } };
  assert.equal(findDuties(tree).length, 1);
});

test('사람이 여럿이면 근무표가 많은 사람부터 센다', () => {
  const tree = {
    김간호: { '2026-09': SEP, '2026-08': AUG },
    이간호: { '2026-09': AUG },
  };
  const people = dutyPeople(findDuties(tree));
  assert.deepEqual(people, [{ person: '김간호', months: 2 }, { person: '이간호', months: 1 }]);
});

test('그 사람 것만 최근 달부터 준다', () => {
  const tree = { 김간호: { '2026-08': AUG, '2026-09': SEP }, 이간호: { '2026-09': AUG } };
  const mine = dutiesOf(findDuties(tree), '김간호');
  assert.deepEqual(mine.map((d) => d.month), ['2026-09', '2026-08']);
});

test('가져온 줄을 날짜별 근무로 바꾼다', () => {
  const out = toShifts('2026-09', SEP);
  assert.equal(out.ok, true, '9월은 30일이고 글자도 30개다');
  assert.equal(out.count, 30);
  assert.equal(out.days['2026-09-01'], 'off');
  assert.equal(out.days['2026-09-04'], 'evening');
  assert.equal(out.days['2026-09-09'], 'night');
  assert.equal(out.days['2026-09-30'], 'day');
});

test('글자 수가 날수와 다르면 어긋났다고 말한다', () => {
  const short = toShifts('2026-09', 'DDEENN');
  assert.equal(short.ok, false);
  assert.equal(short.filled, 6);
  assert.equal(short.last, 30);

  const long = toShifts('2026-02', SEP);   // 2026년 2월은 28일
  assert.equal(long.ok, false);
  assert.equal(long.count, 28, '넘치는 글자는 잘린다');
});

test('한글로 적어 뒀어도 읽는다', () => {
  const text = '오오오이오데데오나나나오데이오오이나나나오오이이오데데데오데';
  const found = findDuties({ 김간호: { '2026-09': text } });
  assert.equal(found.length, 1);
  assert.equal(toShifts('2026-09', found[0].text).days['2026-09-04'], 'evening');
});

test('읽을 주소는 뒤에 .json 을 붙인 것이다', () => {
  assert.equal(dutyEndpoint('https://foo-default-rtdb.asia-southeast1.firebasedatabase.app'),
    'https://foo-default-rtdb.asia-southeast1.firebasedatabase.app/.json');
  assert.equal(dutyEndpoint('https://foo-default-rtdb.asia-southeast1.firebasedatabase.app/'),
    'https://foo-default-rtdb.asia-southeast1.firebasedatabase.app/.json');
  assert.equal(dutyEndpoint('https://foo.firebaseio.com'), 'https://foo.firebaseio.com/.json');
  assert.equal(dutyEndpoint(''), '');
  assert.equal(dutyEndpoint('foo.com'), '', 'https 가 아니면 안 쓴다');
});

test('경로에 사람이 없으면 빈 이름으로 둔다 — 그래도 근무표는 살린다', () => {
  assert.equal(personIn(['shifts', '2026-09'], {}), '');
  assert.equal(findDuties({ shifts: { '2026-09': SEP } })[0].text, SEP);
});

test('너무 깊은 나무에서 헤매지 않는다', () => {
  let deep = SEP;
  for (let i = 0; i < 12; i++) deep = { [`d${i}`]: deep };
  assert.doesNotThrow(() => findDuties(deep));
});

// ── 실제로 쓰는 모양 ─────────────────────────────────────
// duties/{YYYY-MM}/{사번} → { "01": { shift:"D", team:"A" }, "02": {…}, … }
const real = (text, month = '2026-09') => Object.fromEntries(
  [...text].map((ch, i) => [String(i + 1).padStart(2, '0'), { shift: ch, team: 'A' }]));

test('하루가 객체로 싸여 있어도 shift 를 꺼낸다', () => {
  const tree = { duties: { '2026-09': { 224051: real(SEP) } } };
  const found = findDuties(tree);
  assert.equal(found.length, 1);
  assert.equal(found[0].text, SEP);
  assert.equal(found[0].month, '2026-09');
  assert.equal(found[0].person, '224051', '사번이 사람이다');
});

test('사번이 숫자여도 날짜와 헷갈리지 않는다', () => {
  const tree = { duties: { '2026-09': { 224051: real(SEP), 224052: real(AUG.slice(0, 30)) } } };
  assert.deepEqual(dutyPeople(findDuties(tree)).map((p) => p.person).sort(), ['224051', '224052']);
});

test('team 은 사람이 아니라 딸린 값이다', () => {
  const tree = { duties: { '2026-09': { 224051: real(SEP) } } };
  assert.equal(findDuties(tree)[0].person, '224051');
});

test('실제 모양에서 날짜가 안 밀린다', () => {
  const tree = { duties: { '2026-09': { 224051: real(SEP) } } };
  const out = toShifts('2026-09', findDuties(tree)[0].text);
  assert.equal(out.ok, true);
  assert.equal(out.count, 30);
  assert.equal(out.days['2026-09-01'], 'off');
  assert.equal(out.days['2026-09-04'], 'evening');
  assert.equal(out.days['2026-09-09'], 'night');
  assert.equal(out.days['2026-09-30'], 'day');
});

test('근무 없는 날은 자리만 비우고 넘어간다', () => {
  const days = real(SEP);
  delete days['05'].shift;                       // 그 날만 근무가 안 적혀 있다
  days['06'] = { team: 'A' };                    // 아예 비어 있다
  const found = findDuties({ duties: { '2026-09': { 224051: days } } });
  assert.equal(found[0].text[4], '·');
  assert.equal(found[0].text[5], '·');
  assert.equal(found[0].text.length, 30, '뒷날이 밀리지 않는다');
});

test('주소를 달까지 좁혀 넣으면 그 달로 읽는다', () => {
  // …/duties/2026-09.json 을 부르면 나무에 달이 없다
  const tree = { 224051: real(SEP), 224052: real(AUG.slice(0, 30)) };
  assert.deepEqual(findDuties(tree), [], '힌트가 없으면 달을 모른다');

  const found = findDuties(tree, { month: '2026-09' });
  assert.equal(found.length, 2);
  assert.equal(found.find((d) => d.person === '224051').text, SEP);
});

test('주소에서 달을 읽어낸다', () => {
  assert.equal(monthInUrl('https://x.firebasedatabase.app/duties/2026-09'), '2026-09');
  assert.equal(monthInUrl('https://x.firebasedatabase.app/duties/2026-09/224051.json'), '2026-09');
  assert.equal(monthInUrl('https://x.firebasedatabase.app'), '');
});

test('좁힌 주소에도 .json 을 붙이고 두 번 붙이지 않는다', () => {
  assert.equal(dutyEndpoint('https://x.firebasedatabase.app/duties/2026-09'),
    'https://x.firebasedatabase.app/duties/2026-09/.json');
  assert.equal(dutyEndpoint('https://x.firebasedatabase.app/duties/2026-09.json'),
    'https://x.firebasedatabase.app/duties/2026-09/.json');
});

test('사번 하나까지 좁혀 넣어도 읽는다', () => {
  const found = findDuties(real(SEP), { month: '2026-09' });
  assert.equal(found.length, 1);
  assert.equal(found[0].text, SEP);
  assert.equal(found[0].person, '', '경로에 사람이 없으면 이름은 비워 둔다');
});
