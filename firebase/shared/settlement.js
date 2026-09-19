/**
 * 더치페이 정산.
 *
 * 지출 1건에 회수 입금 N건을 붙인다. 보내는 사람마다 금액이 다르게 들어오는 게
 * 정상이라(23,450 요청에 23,450 / 23,500 / 24,000) 정확히 맞아떨어지기를
 * 기다리지 않는다. 허용 오차 안에 들어오면 닫힌 것으로 본다.
 *
 * 통계에는 총액이 아니라 순액(내가 실제 부담한 돈)이 잡힌다.
 * 9만원 쓰고 7만원 돌려받았으면 외식비는 2만원이다.
 */

/** 허용 오차: 예상액의 5%, 최소 1,000원. */
export function toleranceFor(expectedAmount) {
  return Math.max(1000, Math.round(Number(expectedAmount || 0) * 0.05));
}

/**
 * 인원수로 회수 예상액을 낸다. headcount 는 나를 포함한 인원.
 * 4명이면 내 몫을 뺀 3명 몫을 받는다.
 */
export function expectedFromHeadcount(total, headcount) {
  const n = Math.max(2, Number(headcount) || 0);
  const amount = Number(total || 0);
  return amount - Math.round(amount / n);
}

/** 붙은 입금을 더해 상태를 낸다. */
export function settlementState(settlement, links = []) {
  const expected = Number(settlement.expectedAmount || 0);
  const received = links.reduce((sum, l) => sum + Number(l.amount || 0), 0);
  const tolerance = Number(settlement.tolerance) || toleranceFor(expected);
  const remaining = expected - received;
  const settled = Math.abs(remaining) <= tolerance;

  return {
    expected,
    received,
    remaining,
    tolerance,
    settled,
    // 오차 안에서 닫혔을 때 실제로 남은 차액. 더 받았으면 음수.
    diff: settled ? remaining : null,
  };
}

/**
 * 입금이 들어왔을 때 열려 있는 정산 중 후보를 고른다.
 * 남은 금액에 가까운 순. 남은 것보다 훨씬 큰 입금은 급여 같은 것이므로 뺀다.
 */
export function suggestSettlements(amount, settlements = [], links = []) {
  const value = Number(amount || 0);
  if (!value) return [];

  return settlements
    .filter((s) => s.status === 'open')
    .map((s) => {
      const mine = links.filter((l) => l.settlementId === s.id);
      const { remaining } = settlementState(s, mine);
      return { settlementId: s.id, txnId: s.txnId, remaining, gap: Math.abs(remaining - value) };
    })
    .filter((c) => c.remaining > 0 && value <= c.remaining + toleranceFor(c.remaining))
    .sort((a, b) => a.gap - b.gap)
    .slice(0, 3);
}

/**
 * 거래의 순액 = 내가 실제로 부담한 돈.
 * 카테고리 통계와 예산은 이 값을 써야 "이번 달 외식 40만"이 진짜 내 돈이 된다.
 */
export function netAmount(txn, settlements = []) {
  const amount = Number(txn.amount || 0);
  if (!txn.settlementId) return amount;
  const s = settlements.find((x) => x.id === txn.settlementId);
  return s ? amount - Number(s.receivedAmount || 0) : amount;
}
