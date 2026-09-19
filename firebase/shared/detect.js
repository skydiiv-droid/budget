/**
 * 고정비 찾아내기.
 *
 * 매달 같은 곳에 같은 금액이 나가면 그건 고정비다. 그런데 사람은 그걸 등록하러
 * 들어오지 않는다 — 이미 나가고 있으니 불편하지 않으니까. 그러다 "빚 갚을
 * 여력"을 계산할 때 고정비가 비어 있어 답이 틀린다.
 *
 * 자동으로 등록하지는 않는다. 잘못 잡으면 예산이 통째로 틀어지고, 틀어진 걸
 * 알아채기도 어렵다. 찾아만 두고 사람이 누르게 한다.
 *
 * 날짜는 밀리는 쪽으로만 흔들린다 — 자동이체는 쉬는 날이면 다음 영업일로
 * 미뤄지지 앞당겨지지 않는다. 그래서 관측된 날 중 가장 이른 날을 원래 날로 본다.
 */
import { normalizeMerchant } from './parse.js';

export const MIN_MONTHS = 2;        // 이만큼 달이 겹쳐야 고정비로 본다
export const DAY_WINDOW = 4;        // 날짜가 이보다 더 흔들리면 고정비가 아니다
export const SAME_AMOUNT = 0.05;    // 이 안이면 같은 금액으로 본다
/**
 * 금액이 이보다 더 벌어지면 고정비가 아니다.
 *
 * 통신비는 달마다 5만에서 6만을 오가지만 쇼핑은 9만에서 21만을 오간다.
 * 후자를 고정비로 잡으면 예산이 통째로 틀어진다.
 */
export const AMOUNT_FLOOR = 0.5;
/**
 * 금액이 흔들리는 것은 더 지켜본다.
 *
 * 같은 금액이 두 달이면 구독이 맞다. 금액이 달라지는데 두 달뿐이면
 * 우연히 비슷한 날 쇼핑한 것과 구별이 안 된다.
 */
export const MIN_MONTHS_VARIES = 3;

const monthOf = (iso) => String(iso || '').slice(0, 7);
const dayOf = (iso) => Number(String(iso || '').slice(8, 10));

/** 달이 이어진 가장 긴 토막. 6월·8월·9월이면 8월·9월만 남는다. */
function longestRun(picks) {
  const step = (m) => {
    const [y, mm] = m.split('-').map(Number);
    return y * 12 + mm;
  };
  let best = [];
  let run = [];
  for (const t of picks) {
    const prev = run[run.length - 1];
    if (prev && step(monthOf(t.occurredAt)) - step(monthOf(prev.occurredAt)) !== 1) run = [];
    run.push(t);
    if (run.length > best.length) best = [...run];
  }
  return best;
}

/**
 * @param {object} data { transactions, recurring, settings }
 * @returns 제안들. 큰 금액부터.
 */
export function detectRecurring(data = {}, now = new Date()) {
  const { transactions = [], recurring = [], settings = {} } = data;
  const ignored = new Set(settings.ignoredRecurring || []);

  // 이미 등록해 둔 것은 다시 권하지 않는다
  const known = recurring
    .map((r) => normalizeMerchant(r.name))
    .filter(Boolean);

  const groups = new Map();
  for (const t of transactions) {
    if (t.type !== 'expense' || t.status === 'voided') continue;
    const key = normalizeMerchant(t.merchantRaw);
    if (!key || key.length < 2) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const out = [];
  for (const [key, rows] of groups) {
    if (ignored.has(key)) continue;
    if (known.some((k) => key.includes(k) || k.includes(key))) continue;

    // 한 달에 여러 번 긁었으면 가장 이른 것만 — 원래 날에 가장 가깝다
    const perMonth = new Map();
    for (const t of rows) {
      const m = monthOf(t.occurredAt);
      const cur = perMonth.get(m);
      if (!cur || String(t.occurredAt) < String(cur.occurredAt)) perMonth.set(m, t);
    }
    if (perMonth.size < MIN_MONTHS) continue;

    // 고정비는 매달 나간다. 한 달이라도 건너뛰었으면 그냥 가끔 가는 가게다.
    const picks = longestRun([...perMonth.values()].sort((a, b) =>
      String(a.occurredAt).localeCompare(String(b.occurredAt))));
    if (picks.length < MIN_MONTHS) continue;

    const days = picks.map((t) => dayOf(t.occurredAt));
    const spread = Math.max(...days) - Math.min(...days);
    if (spread > DAY_WINDOW) continue;

    const amounts = picks.map((t) => Number(t.amount || 0));
    const high = Math.max(...amounts);
    const low = Math.min(...amounts);
    if (high > 0 && low / high < AMOUNT_FLOOR) continue;
    // 통신비·전기요금처럼 달마다 금액이 바뀌는 것도 고정비다. 빼면 안 된다.
    const varies = high > 0 && (high - low) / high > SAME_AMOUNT;
    if (varies && picks.length < MIN_MONTHS_VARIES) continue;
    const expected = varies
      ? Math.round(amounts.reduce((s, a) => s + a, 0) / amounts.length)
      : amounts[amounts.length - 1];

    out.push({
      key,
      name: picks[picks.length - 1].merchantRaw || key,
      dayOfMonth: Math.min(...days),
      months: picks.map((t) => monthOf(t.occurredAt)),
      amounts,
      expectedAmount: expected,
      varies,
      spread,
      categoryId: picks[picks.length - 1].categoryId || null,
      // 달이 많이 겹치고 금액까지 같으면 더 믿을 만하다
      confidence: Math.min(1, (perMonth.size / 3) * (varies ? 0.7 : 1)),
    });
  }

  return out.sort((a, b) => b.expectedAmount - a.expectedAmount);
}
