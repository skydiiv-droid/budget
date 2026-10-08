/**
 * 한 결제를 카테고리 여러 칸으로 나눈다.
 *
 * 마트에서 장도 보고 뜨개실도 샀다. 카드 문자는 한 통이고 금액도 20,000원
 * 하나인데 그중 5,000원은 취미고 15,000원은 식비다. 카테고리를 하나만
 * 고르게 하면 어느 쪽을 골라도 그림이 틀린다.
 *
 * **거래를 둘로 쪼개지는 않는다.** 쪼개면 문자 한 통에 거래가 둘이 되어
 * 카드사 누적 대조에 없던 "빵꾸"가 생기고, 취소 상계도 원결제를 못 찾는다.
 * 금액은 하나로 두고 **카테고리 배분만** 따로 들고 있는다(`txn.splits`).
 * 그래서 나눠도 총 지출 · 카드사 대조 · 청구액은 1원도 안 달라진다.
 * 달라지는 것은 카테고리별 집계뿐이다.
 *
 * 다 적지 않아도 된다. 적어 둔 조각의 합이 금액보다 적으면 **남은 금액은
 * 그 거래의 카테고리**로 간다. 그래서 "이 중 5,000원만 취미"가 된다.
 *
 * 조각은 **지출 카테고리만** 쓴다. 한 번 긁은 돈의 일부만 옮긴 돈인 경우는
 * 없고, 섞어 두면 총액과 카테고리 합이 어긋난다.
 */

const num = (v) => Number(v || 0);
const whole = (v) => Math.max(0, Math.round(num(v)));

/** 조각을 이만큼까지만 둔다. 이보다 잘게 나눌 일은 없다. */
export const SPLIT_MAX = 8;

/** 쪼개 둔 거래인가. */
export const hasSplit = (txn) =>
  Array.isArray(txn?.splits) && txn.splits.some((s) => s && whole(s.amount) > 0 && s.categoryId);

/** 적어 둔 조각만. 빈 줄과 0원은 버린다. */
const raw = (txn) => (Array.isArray(txn?.splits) ? txn.splits : [])
  .map((s) => ({ categoryId: String(s?.categoryId || ''), amount: whole(s?.amount) }))
  .filter((s) => s.categoryId && s.amount > 0)
  .slice(0, SPLIT_MAX);

/**
 * 거래를 카테고리별 조각으로 나눈다. 안 쪼개 뒀으면 한 조각이다.
 *
 * `net` 을 주면 그 금액을 나눈다 — 승인취소로 일부를 돌려받았으면 세는 돈이
 * 줄어들기 때문이다. 조각 합이 그보다 크면 **비례로 깎는다.** 카테고리 합이
 * 총액을 넘으면 어디가 틀린지 아무도 설명할 수 없다.
 */
export function splitParts(txn = {}, net = null) {
  const total = whole(net == null ? txn.amount : net);
  const parts = raw(txn);
  const mine = String(txn.categoryId || '');

  if (!parts.length) return [{ categoryId: mine, amount: total, rest: true }];

  const sum = parts.reduce((s, p) => s + p.amount, 0);

  if (sum === total) return parts.map((p) => ({ ...p, rest: false }));

  // 다 적지 않았다. 남은 금액은 그 거래의 카테고리로 간다.
  if (sum < total) {
    return [...parts.map((p) => ({ ...p, rest: false })),
            { categoryId: mine, amount: total - sum, rest: true }];
  }

  // 합이 총액을 넘는다 — 나눠 둔 뒤에 부분취소가 들어왔거나 금액을 고쳤다.
  let left = total;
  return parts
    .map((p, i) => {
      const take = i === parts.length - 1 ? left : Math.min(left, Math.round(total * p.amount / sum));
      left -= take;
      return { ...p, amount: take, rest: false };
    })
    .filter((p) => p.amount > 0);
}

/** 이 거래가 그 카테고리에 얼마를 넣고 있나. 하위까지 끌어오려면 `under` 에 묶어 넘긴다. */
export function partIn(txn, under, net = null) {
  const ids = under instanceof Set ? under : new Set([under]);
  return splitParts(txn, net)
    .filter((p) => ids.has(p.categoryId || 'cat_unknown'))
    .reduce((s, p) => s + p.amount, 0);
}

/**
 * 폼에서 받은 조각을 저장할 모양으로 다듬는다.
 *
 * 합이 총액을 넘는 것만 막는다. 모자란 것은 막지 않는다 — 남은 금액이
 * 그 거래의 카테고리로 가는 것이 이 기능의 요점이다.
 */
export function cleanSplits(list = [], total = 0) {
  const parts = list
    .map((s) => ({ categoryId: String(s?.categoryId || ''), amount: whole(s?.amount) }))
    .filter((s) => s.categoryId && s.amount > 0);

  if (parts.length > SPLIT_MAX) {
    return { ok: false, reason: 'many', splits: [], rest: 0 };
  }

  const sum = parts.reduce((s, p) => s + p.amount, 0);
  const cap = whole(total);
  if (sum > cap) return { ok: false, reason: 'over', over: sum - cap, splits: [], rest: 0 };

  return { ok: true, splits: parts, rest: cap - sum };
}
