/**
 * 근무별 지출.
 *
 * 3교대는 하루의 모양이 매일 다르다. 나이트 끝나고 새벽에 쓰는 돈과 오프 날
 * 쓰는 돈은 성격이 완전히 다른데, 달력으로만 보면 둘 다 그냥 "9월 19일"이다.
 *
 * 시중 가계부는 이걸 모른다. 우리는 근무표만 넣으면 안다.
 *
 * 새벽 지출은 앞 근무로 친다. 나이트 도중에 산 커피는 그 나이트에 쓴 돈이지
 * 다음 날 쓴 돈이 아니다.
 */
import { netAmount } from './settlement.js';

export const SHIFT_KINDS = ['day', 'evening', 'night', 'off'];
export const SHIFT_LABEL = { day: '데이', evening: '이브닝', night: '나이트', off: '오프' };

/** 근무표에서 흔히 쓰는 글자. 한글로 적어도 알아듣는다. */
const LETTER = {
  D: 'day', E: 'evening', N: 'night', O: 'off', X: 'off',
  데: 'day', 이: 'evening', 나: 'night', 오: 'off', 휴: 'off',
};

/** 이 시각 전에 쓴 돈은 앞 근무 것으로 본다. */
export const DAWN_HOUR = 8;

/**
 * 한 달치 근무표를 읽는다.
 *
 * "DDEENNOO..." 처럼 하루 한 글자로 죽 적거나, 띄어쓰기·쉼표로 나눠 적어도 된다.
 * 1일부터 차례로 붙는다.
 */
export function parseShiftText(text, yyyymm) {
  const [y, m] = String(yyyymm).split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const out = {};
  let day = 0;

  for (const ch of String(text || '').toUpperCase()) {
    const kind = LETTER[ch];
    if (!kind) continue;               // 띄어쓰기·쉼표·줄바꿈은 그냥 넘긴다
    day += 1;
    if (day > last) break;
    out[`${yyyymm}-${String(day).padStart(2, '0')}`] = kind;
  }
  return out;
}

/** 다시 글자로. 고칠 때 지금 값을 보여 주려면 필요하다. */
export function shiftText(shifts = {}, yyyymm) {
  const [y, m] = String(yyyymm).split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const back = { day: 'D', evening: 'E', night: 'N', off: 'O' };
  let s = '';
  for (let d = 1; d <= last; d++) {
    s += back[shifts[`${yyyymm}-${String(d).padStart(2, '0')}`]] || '·';
  }
  return s;
}

/** 그 거래가 어느 날의 근무에 속하는가. 새벽이면 앞날이다. */
export function shiftDateOf(occurredAt) {
  const d = new Date(occurredAt);
  if (Number.isNaN(d.getTime())) return '';
  if (d.getHours() < DAWN_HOUR) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 근무 유형마다 하루에 얼마씩 쓰나.
 *
 * 총액이 아니라 하루 평균으로 낸다. 오프가 나이트보다 많은 건 오프가 많아서일
 * 수도 있어서, 총액만 보면 아무것도 알 수 없다.
 */
export function shiftStats(data = {}) {
  const { transactions = [], shifts = {}, settlements = [] } = data;

  const spentOn = new Map();
  for (const t of transactions) {
    if (t.type !== 'expense' || t.status === 'voided' || t.excludeFromBudget) continue;
    const net = netAmount(t, settlements);
    if (net <= 0) continue;
    const key = shiftDateOf(t.occurredAt);
    if (!key) continue;
    spentOn.set(key, (spentOn.get(key) || 0) + net);
  }

  const bucket = () => ({ days: 0, total: 0, spentDays: 0 });
  const byKind = Object.fromEntries(SHIFT_KINDS.map((k) => [k, bucket()]));
  const afterNight = bucket();

  const dayBefore = (key) => {
    const d = new Date(`${key}T12:00:00`);
    d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  for (const [key, kind] of Object.entries(shifts)) {
    const b = byKind[kind];
    if (!b) continue;
    const spent = spentOn.get(key) || 0;
    b.days += 1;
    b.total += spent;
    if (spent > 0) b.spentDays += 1;

    // 나이트를 마치고 나온 날. 근무가 아니라 그 다음 하루가 어떤지가 궁금한 것이다.
    if (shifts[dayBefore(key)] === 'night') {
      afterNight.days += 1;
      afterNight.total += spent;
      if (spent > 0) afterNight.spentDays += 1;
    }
  }

  const done = (b, id, label) => ({
    id, label, days: b.days, total: b.total, spentDays: b.spentDays,
    perDay: b.days ? Math.round(b.total / b.days) : 0,
  });

  const items = SHIFT_KINDS.map((k) => done(byKind[k], k, SHIFT_LABEL[k]))
    .filter((i) => i.days > 0)
    .sort((a, b) => b.perDay - a.perDay);

  return {
    items,
    afterNight: afterNight.days ? done(afterNight, 'afterNight', '나이트 다음 날') : null,
    days: items.reduce((s, i) => s + i.days, 0),
    // 가장 많이 쓰는 근무와 가장 적게 쓰는 근무의 차이. 이게 작으면 볼 게 없다.
    gap: items.length >= 2 ? items[0].perDay - items[items.length - 1].perDay : 0,
  };
}
