/**
 * 쓴 돈과 옮긴 돈.
 *
 * 적금에 넣은 50만원은 **없어진 돈이 아니다.** 주머니에서 주머니로 옮겼을
 * 뿐인데 지출로 세면 그달에 50만원을 쓴 것이 되고, 예산도 카테고리 그림도
 * 근무별 평균도 전부 그만큼 부풀어 오른다.
 *
 * 가르는 기준은 **카테고리의 성격**이다. 거래의 `type` 이 아니라.
 *
 *   type: 'transfer'          문자에서 바로 알아본 것 (카드대금 · ATM)
 *   카테고리 kind: 'transfer' 사람이 보고 "이건 저축이야" 하고 고친 것
 *
 * 앞엣것만 보고 있었다. 그래서 저축투자로 바꿔 놔도 지출로 계속 세었다 —
 * 고치는 길이 있는데 고쳐지지 않는 건 없는 것보다 나쁘다.
 *
 * 다만 **카드사 대조와 청구액에서는 빼지 않는다.** 카드사는 우리가 그걸
 * 뭐라 부르든 제 누적에 넣는다. 거기서 빼면 없던 "빵꾸"가 생긴다.
 */

/** 옮긴 돈으로 치는 카테고리들. */
export const transferCats = (categories = []) =>
  new Set(categories.filter((c) => c && c.kind === 'transfer').map((c) => c.id));

/** 이 거래는 쓴 돈이 아니라 옮긴 돈인가. */
export function isMoved(txn, moved) {
  if (!txn) return false;
  if (txn.type === 'transfer') return true;
  return Boolean(txn.categoryId && moved && moved.has(txn.categoryId));
}

/**
 * 문자만 보고 "옮긴 돈"이라고 말할 수 있는 말들.
 *
 * 애매한 건 넣지 않는다 — **이체 · 송금**은 지인에게 보낸 돈일 수도 있어서
 * 빼 뒀다. 그런 건 확인 탭에서 사람이 고르게 둔다. 짐작해서 조용히 빼면
 * 쓴 돈이 안 보이고, 그건 부풀리는 것보다 더 나쁘다.
 */
const SAVING = /적금|예금|저축|청약|펀드|증권|투자|신탁|ISA|연금/i;

/** 저축으로 흘러간 돈인가. */
export const looksLikeSaving = (text) => SAVING.test(String(text || ''));
