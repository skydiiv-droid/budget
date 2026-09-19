/**
 * 더치페이 정산.
 *
 * 지출 1건에 회수 입금 N건을 붙인다. 보내는 사람마다 금액이 다르게 들어오는 게
 * 정상이라(23,450 요청에 23,450 / 23,500 / 24,000) 정확히 맞아떨어지기를
 * 기다리지 않는다. 허용 오차 안에 들어오면 닫힌 것으로 본다.
 *
 * 통계에는 총액이 아니라 순액(내가 실제 부담한 돈)이 잡힌다.
 * 9만원 결제하고 7만원 돌려받았으면 외식비는 2만원이다.
 */

/** 허용 오차: 예상액의 5%, 최소 1,000원. */
function toleranceFor_(expectedAmount) {
  return Math.max(1000, Math.round(expectedAmount * 0.05));
}

/**
 * 지출 건에서 "더치페이"를 누르면 호출된다.
 *   headcount를 주면 (나 포함 인원) 내 몫을 뺀 나머지를 회수 예상액으로 잡는다.
 *   expectedAmount를 직접 주면 그 값을 쓴다.
 */
function openSettlement(payload) {
  const txn = findBy_('Transaction', 'id', payload.txnId);
  if (!txn) return { status: 'error', reason: 'txn-not-found' };
  if (txn.settlementId) return { status: 'error', reason: 'already-open', settlementId: txn.settlementId };

  const total = Number(txn.amount);
  let expected = parseAmount_(payload.expectedAmount);
  if (expected === null && payload.headcount) {
    const headcount = Math.max(2, Number(payload.headcount));
    expected = total - Math.round(total / headcount);   // 내 몫을 뺀 나머지
  }
  if (expected === null) return { status: 'error', reason: 'need-expected-or-headcount' };

  const settlement = {
    id: newId_('stl'),
    txnId: txn.id,
    expectedAmount: expected,
    receivedAmount: 0,
    tolerance: toleranceFor_(expected),
    status: 'open',
    note: payload.note || '',
    createdAt: nowIso_(),
    closedAt: '',
  };
  append_('Settlement', settlement);
  update_('Transaction', txn.id, { settlementId: settlement.id });

  return {
    status: 'ok',
    settlementId: settlement.id,
    expectedAmount: expected,
    tolerance: settlement.tolerance,
    myShare: total - expected,
  };
}

/** 입금 거래 하나를 정산에 붙인다. */
function linkSettlement(payload) {
  const settlement = findBy_('Settlement', 'id', payload.settlementId);
  if (!settlement) return { status: 'error', reason: 'settlement-not-found' };

  const income = findBy_('Transaction', 'id', payload.incomeTxnId);
  if (!income) return { status: 'error', reason: 'income-not-found' };
  if (findBy_('SettlementLink', 'incomeTxnId', income.id)) {
    return { status: 'error', reason: 'already-linked' };
  }

  append_('SettlementLink', {
    id: newId_('lnk'),
    settlementId: settlement.id,
    incomeTxnId: income.id,
    amount: Number(income.amount),
    linkedAt: nowIso_(),
    note: payload.note || '',
  });

  // 회수 입금은 진짜 수입이 아니므로 수입 합계에서 뺀다
  update_('Transaction', income.id, {
    categoryId: 'cat_settle_in',
    status: 'confirmed',
    excludeFromBudget: true,
    settlementId: settlement.id,
  });

  return recomputeSettlement_(settlement.id);
}

/** 붙은 입금을 다시 더해 상태를 갱신한다. */
function recomputeSettlement_(settlementId) {
  const settlement = findBy_('Settlement', 'id', settlementId);
  if (!settlement) return { status: 'error', reason: 'settlement-not-found' };

  const received = readAll_('SettlementLink')
    .filter(function (l) { return l.settlementId === settlementId; })
    .reduce(function (sum, l) { return sum + Number(l.amount || 0); }, 0);

  const expected = Number(settlement.expectedAmount);
  const tolerance = Number(settlement.tolerance) || toleranceFor_(expected);
  const remaining = expected - received;
  const closed = Math.abs(remaining) <= tolerance;

  update_('Settlement', settlementId, {
    receivedAmount: received,
    status: closed ? 'closed' : 'open',
    closedAt: closed ? nowIso_() : '',
  });

  return {
    status: 'ok',
    settlementId: settlementId,
    expectedAmount: expected,
    receivedAmount: received,
    remaining: remaining,
    tolerance: tolerance,
    settled: closed,
    // 오차 범위 안에서 닫혔을 때 실제로 남은 차액. 더 받았으면 음수.
    diff: closed ? remaining : null,
  };
}

/**
 * 입금 문자가 들어왔을 때 열려 있는 정산 중 후보를 고른다.
 * 남은 금액에 가까운 순. 1/N 금액에 가까운 것도 후보에 넣는다.
 */
function suggestSettlements_(amount) {
  if (!amount) return [];
  const links = readAll_('SettlementLink');

  return readAll_('Settlement')
    .filter(function (s) { return s.status === 'open'; })
    .map(function (s) {
      const received = links
        .filter(function (l) { return l.settlementId === s.id; })
        .reduce(function (sum, l) { return sum + Number(l.amount || 0); }, 0);
      const remaining = Number(s.expectedAmount) - received;
      const txn = findBy_('Transaction', 'id', s.txnId);
      return {
        settlementId: s.id,
        merchant: txn ? txn.merchantRaw : '',
        occurredAt: txn ? txn.occurredAt : '',
        remaining: remaining,
        gap: Math.abs(remaining - amount),
      };
    })
    // 남은 금액보다 크게 들어온 입금은 이 정산 건이 아닐 가능성이 높다
    .filter(function (c) { return c.remaining > 0 && amount <= c.remaining + toleranceFor_(c.remaining); })
    .sort(function (a, b) { return a.gap - b.gap; })
    .slice(0, 3);
}

/**
 * 거래의 순액 = 내가 실제로 부담한 돈.
 * 카테고리 통계와 예산은 이 값을 써야 "이번 달 외식 40만"이 진짜 내 돈이 된다.
 */
function netAmountOf_(txn) {
  const amount = Number(txn.amount || 0);
  if (!txn.settlementId) return amount;
  const settlement = findBy_('Settlement', 'id', txn.settlementId);
  if (!settlement) return amount;
  return amount - Number(settlement.receivedAmount || 0);
}
