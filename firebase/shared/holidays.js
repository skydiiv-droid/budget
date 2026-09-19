/**
 * 영업일.
 *
 * 돈이 오가는 날은 달력 날짜가 아니다. 방향에 따라 반대로 움직인다.
 *
 *   들어오는 것(급여) — 쉬는 날이면 **앞당겨** 들어온다. 5일이 일요일이면 3일 금요일.
 *   나가는 것(카드값·자동이체) — 쉬는 날이면 **미뤄서** 빠진다. 10일이 토요일이면 12일 월요일.
 *
 * 은행이 쉬는 날이 기준이라 근로자의날(5/1)도 넣는다. 공휴일은 아니지만
 * 금융기관은 쉬어서 이체가 안 돈다.
 */

/** 해마다 날짜가 같은 것. 세 번째 칸은 주말과 겹칠 때 대체공휴일이 붙는가. */
const SOLAR = [
  ['01-01', '신정', false],
  ['03-01', '삼일절', true],
  ['05-01', '근로자의날', false],
  ['05-05', '어린이날', true],
  ['06-06', '현충일', false],
  ['08-15', '광복절', true],
  ['10-03', '개천절', true],
  ['10-09', '한글날', true],
  ['12-25', '성탄절', true],
];

/**
 * 음력에서 오는 것 — 설 · 부처님오신날 · 추석. 해마다 날이 달라 표로 들고 있어야 한다.
 *
 * 해가 넘어가면 여기가 비어서 그해 설·추석을 놓친다. 설정에서 직접 넣을 수
 * 있게 열어 두었고, 표에 없는 해는 주말만 보고 넘어간다 — 틀려도 하루 이틀
 * 어긋날 뿐이고 실제 날짜는 어차피 문자로 들어온다.
 */
const LUNAR = {
  2025: ['01-28', '01-29', '01-30', '05-05', '05-06', '10-05', '10-06', '10-07', '10-08'],
  2026: ['02-16', '02-17', '02-18', '05-24', '05-25', '09-24', '09-25', '09-26'],
  2027: ['02-06', '02-07', '02-08', '05-13', '09-14', '09-15', '09-16'],
};

export const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;

/** 그해 쉬는 날 전부. 대체공휴일까지 붙여서 돌려준다. */
export function holidaysIn(year, extra = []) {
  const set = new Set();
  const substitutes = [];

  for (const [md, , canSubstitute] of SOLAR) {
    set.add(`${year}-${md}`);
    if (canSubstitute) substitutes.push(`${year}-${md}`);
  }
  for (const md of LUNAR[year] || []) {
    set.add(`${year}-${md}`);
    substitutes.push(`${year}-${md}`);
  }

  // 주말과 겹치면 다음 평일 하루를 대체공휴일로 준다
  for (const key of substitutes) {
    const d = new Date(`${key}T00:00:00`);
    if (!isWeekend(d)) continue;
    const to = new Date(d);
    do { to.setDate(to.getDate() + 1); } while (isWeekend(to) || set.has(ymd(to)));
    set.add(ymd(to));
  }

  for (const key of extra) if (key) set.add(String(key).trim());
  return set;
}

const cache = new Map();
function yearSet(year, extra) {
  if (extra?.length) return holidaysIn(year, extra);   // 직접 넣은 게 있으면 캐시하지 않는다
  if (!cache.has(year)) cache.set(year, holidaysIn(year));
  return cache.get(year);
}

export function isBankHoliday(date, extra = []) {
  const d = new Date(date);
  return isWeekend(d) || yearSet(d.getFullYear(), extra).has(ymd(d));
}

/** 나가는 돈. 그날이 쉬는 날이면 열리는 날까지 미룬다. */
export function nextBusinessDay(date, extra = []) {
  const d = new Date(date);
  let guard = 0;
  while (isBankHoliday(d, extra) && guard++ < 30) d.setDate(d.getDate() + 1);
  return d;
}

/** 들어오는 돈. 그날이 쉬는 날이면 열려 있던 날로 앞당긴다. */
export function prevBusinessDay(date, extra = []) {
  const d = new Date(date);
  let guard = 0;
  while (isBankHoliday(d, extra) && guard++ < 30) d.setDate(d.getDate() - 1);
  return d;
}

/** 그 달 며칟날이 실제로 돈이 오가는 날인지. */
export function payDate(year, month, day, direction = 'out', extra = []) {
  const nominal = new Date(year, month, Math.min(day, new Date(year, month + 1, 0).getDate()));
  return direction === 'in'
    ? prevBusinessDay(nominal, extra)
    : nextBusinessDay(nominal, extra);
}
