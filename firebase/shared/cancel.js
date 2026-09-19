/**
 * 승인취소 · 환불 맞물리기.
 *
 * 취소 문자가 오면 지출이 한 건 더 쌓이는 게 아니라 원래 결제가 없던 일이 돼야
 * 한다. 안 그러면 쓴 적 없는 돈이 통계에 남고, 카드값 예상도 틀어진다.
 *
 * 같은 카드 · 같은 금액이 열쇠다. 취소 문자에는 가맹점이 붙기도 하고 안 붙기도
 * 해서, 붙어 있으면 더 좁히고 없으면 금액과 카드만으로 찾는다.
 *
 * 후보가 여럿이면 자동으로 정하지 않는다. 같은 가게에서 같은 금액을 두 번 긁는
 * 일은 흔하고, 엉뚱한 쪽을 지우면 찾기가 더 어렵다.
 */
import { normalizeMerchant } from './parse.js';

/** 이만큼 지난 건은 후보로 보지 않는다. */
export const CANCEL_WINDOW_DAYS = 60;
/** 이 안에서 가맹점까지 맞으면 물어보지 않고 맞물린다. */
export const CONFIDENT_DAYS = 7;

const at = (t) => new Date(t?.occurredAt || 0).getTime();
const sameCard = (a, b) => {
  if (a.accountId && b.accountId) return a.accountId === b.accountId;
  if (a.cardName && b.cardName) return a.cardName === b.cardName;
  return true;   // 둘 중 하나가 비어 있으면 카드로는 못 가른다
};

/**
 * 취소 한 건에 맞물릴 원래 결제를 찾는다.
 *
 * @returns {{ match, candidates, confident, why }}
 */
export function findOriginal(cancel, transactions = []) {
  const amount = Number(cancel?.amount || 0);
  const when = at(cancel);
  if (!amount || !when) return { match: null, candidates: [], confident: false, why: 'no-amount' };

  const merchant = normalizeMerchant(cancel.merchantRaw);

  const pool = transactions.filter((t) =>
    t.id !== cancel.id
    && t.type === 'expense'
    && t.status !== 'voided'
    && !t.voidedBy
    && Number(t.amount) === amount
    && sameCard(cancel, t)
    && at(t) <= when
    && when - at(t) <= CANCEL_WINDOW_DAYS * 86400000);

  if (!pool.length) return { match: null, candidates: [], confident: false, why: 'none' };

  // 가맹점이 붙어 있으면 그걸로 좁힌다. 좁혀서 아무것도 안 남으면 안 좁힌 걸 쓴다.
  const narrowed = merchant
    ? pool.filter((t) => {
        const other = normalizeMerchant(t.merchantRaw);
        return other && (other === merchant || other.includes(merchant) || merchant.includes(other));
      })
    : [];
  const candidates = (narrowed.length ? narrowed : pool)
    .sort((a, b) => at(b) - at(a));            // 가까운 것부터

  const only = candidates.length === 1;
  const near = when - at(candidates[0]) <= CONFIDENT_DAYS * 86400000;
  const named = narrowed.length > 0;

  return {
    match: candidates[0],
    candidates,
    // 하나뿐이고 가깝고 가맹점까지 맞을 때만 묻지 않는다
    confident: only && near && (named || !merchant),
    why: only ? (near ? 'one-near' : 'one-far') : 'many',
  };
}

/** 취소로 없던 일이 된 결제에 붙일 표시. */
export function voidPatch(cancel) {
  return {
    status: 'voided',
    voidedBy: cancel.id,
    voidedAt: cancel.occurredAt || new Date().toISOString(),
  };
}

/** 취소 쪽에 붙일 표시. 맞물린 뒤에는 정리 목록에서 빠진다. */
export function settledPatch(original) {
  return { status: 'settled', offsetsId: original.id };
}

/** 아직 원래 결제를 못 찾은 취소들. */
export const openCancels = (transactions = []) =>
  transactions.filter((t) => t.type === 'cancel' && t.status !== 'settled' && !t.offsetsId);
