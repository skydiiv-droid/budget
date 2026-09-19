/**
 * 수집 파이프라인.
 *
 *   [1] RawMessage 저장 (무손실)
 *   [2] 중복이면 종료
 *   [3] 파싱  -> 실패해도 RawMessage는 남는다 (인박스행)
 *   [4] 거래 생성
 *   [5] 청구 스케줄 생성
 *   [6] 앵커 기록 (잔액 / 월 누적)
 *   [7] 단축어에 결과 반환 -> 미분류면 아이폰에서 메뉴를 띄운다
 */

function ingest(payload) {
  const body = String(payload.body || '');
  const sender = String(payload.sender || '');
  const receivedAt = payload.receivedAt ? new Date(payload.receivedAt) : new Date();

  // 결제 직후에 문자가 오므로 이 좌표는 사실상 가맹점 위치다.
  // 지하/실내에서는 못 잡을 수 있어 없어도 그대로 진행한다.
  const location = (payload.lat !== undefined && payload.lat !== null && payload.lat !== '')
    ? { lat: Number(payload.lat), lon: Number(payload.lon), placeName: payload.placeName || '' }
    : null;

  if (!body.trim()) return { status: 'ignored', reason: 'empty-body' };

  // [2] 중복 — 단축어가 같은 문자를 두 번 넘기는 경우가 있다
  const key = dedupeKey_(body, receivedAt);
  if (findBy_('RawMessage', 'dedupeKey', key)) {
    return { status: 'duplicate' };
  }

  // [1] 원문 저장
  const rawId = newId_('raw');
  append_('RawMessage', {
    id: rawId,
    receivedAt: toIso_(receivedAt),
    sender: sender,
    body: body,
    dedupeKey: key,
    parserVersion: CONFIG.parserVersion,
    parsedOk: false,
    parseNote: '',
    txnId: '',
    ingestedAt: nowIso_(),
  });

  // [3] 파싱
  const parsed = parseMessage_(body, sender, receivedAt);
  update_('RawMessage', rawId, { parsedOk: parsed.ok, parseNote: parsed.note });

  if (parsed.kind === 'ad') {
    return { status: 'ignored', reason: 'ad' };
  }
  if (!parsed.ok) {
    return { status: 'parse_failed', rawId: rawId, note: parsed.note };
  }

  return materialize_(parsed, rawId, location);
}

/**
 * 파싱 결과를 거래로 만든다.
 *
 * ingest()와 reprocessAll()이 함께 쓴다. 파서를 고친 뒤 과거 문자를 다시 읽었을 때
 * 거래까지 생겨야 "원문을 남겨두면 나중에 복구된다"가 실제로 성립한다.
 */
function materialize_(parsed, rawId, location) {
  // [6] 앵커 — 문자에 찍힌 잔액/누적을 기록해 두고 나중에 앱 계산값과 대조한다
  recordAnchors_(parsed, rawId);

  if (parsed.kind === 'cancel') {
    // 승인취소 매칭은 M2. 지금은 원문만 남기고 인박스로 보낸다.
    return { status: 'needs_review', rawId: rawId, reason: 'cancel', amount: parsed.amount };
  }

  // [4] 거래 생성
  const txn = buildTransaction_(parsed, rawId, location);
  const decision = txn.type === 'expense'
    ? classify_(parsed.merchantRaw, parsed.amount, location)
    : { categoryId: txn.categoryId, reason: 'fixed' };

  txn.categoryId = decision.categoryId || '';
  txn.merchantId = decision.merchantId || '';
  txn.status = txn.categoryId ? 'confirmed' : 'pendingCategory';
  append_('Transaction', txn);
  update_('RawMessage', rawId, { txnId: txn.id });

  // [5] 청구 스케줄
  buildSchedules_(txn).forEach(function (s) { append_('PaymentSchedule', s); });

  // [7] 단축어 응답
  const response = {
    status: txn.categoryId ? 'categorized' : 'uncategorized',
    txnId: txn.id,
    merchant: parsed.merchantRaw || '(가맹점 미상)',
    amount: parsed.amount,
    type: txn.type,
    categoryId: txn.categoryId,
    confidence: parsed.confidence,
    layer: parsed.layer,
    reason: decision.reason,
    placeName: location ? location.placeName : '',
    suggestions: suggestionsFor_(decision),
  };

  // 미분류면 단축어가 그대로 띄울 메뉴를 함께 보낸다.
  // 단축어는 JSON을 헤집지 않고 "줄바꿈으로 나누기 -> 목록에서 선택" 만 하면 된다.
  if (!txn.categoryId && txn.type === 'expense') {
    response.learnHint = suggestKeyword_(parsed.merchantRaw);
    response.menuText = categoryMenuText_(decision);
    response.scopeMenuText = scopeMenuText_(parsed.merchantRaw);
    response.prompt = (parsed.merchantRaw || '가맹점 미상') + ' ' +
                      Number(parsed.amount || 0).toLocaleString() + '원';
  }

  // 입금이면 열려 있는 더치페이 정산 후보를 함께 돌려준다.
  // 23,450 요청에 23,500이 들어와도 붙일 수 있게 오차를 허용해 고른다.
  if (txn.type === 'income') {
    const candidates = suggestSettlements_(parsed.amount);
    if (candidates.length) {
      response.status = 'settlement_candidate';
      response.settlements = candidates;
    }
  }

  return response;
}

/**
 * 알림 메뉴에 올릴 후보.
 * 위치로 짚이는 게 있으면 그걸 맨 앞에 놓는다 — 같은 자리에서 쓴 적이 있다는 뜻이라
 * 빈도 상위 카테고리보다 맞을 확률이 높다.
 */
function suggestionsFor_(decision) {
  const top = topCategories_(3);
  const nearby = decision && decision.nearby;
  if (!nearby || !nearby.categoryId) return top;

  const hinted = findBy_('Category', 'id', nearby.categoryId);
  if (!hinted) return top;

  const rest = top.filter(function (c) { return c.id !== nearby.categoryId; });
  return [{
    id: hinted.id,
    name: hinted.name,
    icon: hinted.icon,
    hint: '같은 자리에서 ' + nearby.samples + '번',
  }].concat(rest).slice(0, 3);
}

function buildTransaction_(parsed, rawId, location) {
  const accountId = accountFor_(parsed.issuer, parsed.cardName);
  const txn = {
    id: newId_('txn'),
    type: 'expense',
    amount: parsed.amount,
    currency: 'KRW',
    occurredAt: toIso_(parsed.occurredAt),
    accountId: accountId,
    counterAccountId: '',
    categoryId: '',
    merchantRaw: parsed.merchantRaw || '',
    merchantId: '',
    memo: '',
    payMethod: parsed.installmentMonths > 0 ? 'installment' : 'lump',
    installmentMonths: parsed.installmentMonths || 0,
    status: 'pendingCategory',
    voidsTxnId: '',
    voidedByTxnId: '',
    source: 'sms',
    rawMessageId: rawId,
    dedupeKey: '',
    excludeFromBudget: false,
    lat: location ? location.lat : '',
    lon: location ? location.lon : '',
    placeName: location ? location.placeName : '',
    settlementId: '',
  };

  if (parsed.kind === 'deposit') {
    txn.type = 'income';
    txn.categoryId = 'cat_salary';
    return txn;
  }

  if (parsed.kind === 'withdrawal') {
    // 카드대금 출금은 지출이 아니라 계정 간 이체다.
    // 이걸 지출로 잡으면 매달 카드값만큼 지출이 부풀어 오른다.
    if (isCardBill_(parsed.merchantRaw)) {
      txn.type = 'transfer';
      txn.counterAccountId = cardAccountForBill_(parsed.amount, txn.occurredAt);
      txn.categoryId = 'cat_cardbill';
      txn.excludeFromBudget = true;
    } else if (isAtm_(parsed.merchantRaw)) {
      txn.type = 'transfer';
      txn.counterAccountId = 'acc_cash';
      txn.categoryId = 'cat_withdraw';
      txn.excludeFromBudget = true;
    }
    return txn;
  }

  return txn;   // approval -> expense
}

/**
 * 카드 대금이 빠져나갈 때 어느 카드 것인지 고른다.
 *
 * 은행 문자에는 적요가 "현대카드"로만 찍혀 카드를 알 수 없다. 그래서 카드마다
 * 이번 청구 예정액을 더해 보고 빠져나간 금액에 가장 가까운 쪽을 고른다.
 * 카드가 한 장이면 그냥 그 카드다.
 */
function cardAccountForBill_(amount, occurredAt) {
  const cards = readAll_('Account').filter(function (a) { return a.type === 'card'; });
  if (!cards.length) return '';
  if (cards.length === 1) return cards[0].id;

  const month = String(occurredAt || '').slice(0, 7);   // yyyy-MM
  const dueByCard = {};
  readAll_('PaymentSchedule').forEach(function (sch) {
    if (sch.settled === true || sch.settled === 'TRUE') return;
    if (String(sch.dueDate || '').slice(0, 7) !== month) return;
    dueByCard[sch.accountId] = (dueByCard[sch.accountId] || 0) + Number(sch.amount || 0);
  });

  let best = cards[0].id;
  let bestGap = Infinity;
  cards.forEach(function (card) {
    const due = dueByCard[card.id];
    if (due === undefined) return;            // 청구 예정이 없는 카드는 후보가 아니다
    const gap = Math.abs(due - Number(amount || 0));
    if (gap < bestGap) { bestGap = gap; best = card.id; }
  });
  return best;
}

function isCardBill_(merchantRaw) {
  return /현대\s*카드|카드\s*대금|일시불대금/.test(String(merchantRaw || ''));
}

function isAtm_(merchantRaw) {
  return /ATM|CD기|현금인출/i.test(String(merchantRaw || ''));
}

/**
 * 어느 계정의 거래인지 가린다.
 *
 * 카드가 여러 장이면 상품명으로 찾는다. 못 찾으면 그 발급사의 첫 카드로
 * 떨어뜨린다 — 금액을 잃는 것보다 계정이 틀린 편이 낫고, 나중에 고칠 수 있다.
 */
function accountFor_(issuer, cardName) {
  if (issuer === '우리은행') return 'acc_woori';
  if (issuer !== '현대카드') return '';

  const cards = readAll_('Account').filter(function (a) {
    return a.type === 'card' && a.issuer === '현대카드';
  });
  if (!cards.length) return '';

  const wanted = normalizeMerchant_(cardName || '');
  if (wanted) {
    const matched = cards.filter(function (a) {
      return normalizeMerchant_(a.name).indexOf(wanted) >= 0;
    })[0];
    if (matched) return matched.id;
  }
  return cards[0].id;
}

/**
 * 청구 스케줄 = "언제 얼마가 나가나".
 *   일시불   -> 다음 결제일 1건
 *   N개월 할부 -> 다음 결제일부터 N건 (1원 단위 잔돈은 첫 회차에 몰아준다)
 *   리볼빙   -> 결제일마다 약정 비율로 다시 계산한다 (M4)
 * 체크/계좌 거래는 즉시 결제이므로 스케줄을 만들지 않는다.
 */
function buildSchedules_(txn) {
  if (txn.type !== 'expense') return [];
  const account = findBy_('Account', 'id', txn.accountId);
  if (!account || account.type !== 'card') return [];

  const billingDay = Number(account.billingDay) || 5;
  const months = Math.max(1, Number(txn.installmentMonths) || 1);
  const base = Math.floor(txn.amount / months);
  const remainder = txn.amount - base * months;

  const occurred = new Date(txn.occurredAt);
  const out = [];
  for (let i = 0; i < months; i++) {
    // 사용월의 다음 달 결제일부터 시작한다
    const due = new Date(occurred.getFullYear(), occurred.getMonth() + 1 + i, billingDay);
    out.push({
      id: newId_('sch'),
      txnId: txn.id,
      accountId: txn.accountId,
      dueDate: Utilities.formatDate(due, CONFIG.timezone, 'yyyy-MM-dd'),
      amount: base + (i === 0 ? remainder : 0),
      seq: i + 1,
      kind: months > 1 ? 'installment' : 'lump',
      settled: false,
      settledTxnId: '',
    });
  }
  return out;
}

/**
 * 앵커 기록.
 *   우리은행 잔액   -> 계좌 잔액 대조
 *   현대카드 월 누적 -> 이번 달 카드 사용 합계 대조 (사이클이 1일 기준이라 경계가 일치한다)
 * computed와 diff는 대사 실행 시 채운다.
 */
function recordAnchors_(parsed, rawId) {
  if (parsed.balance !== null && parsed.balance !== undefined) {
    append_('Anchor', {
      id: newId_('anc'), at: toIso_(parsed.occurredAt),
      accountId: accountFor_(parsed.issuer, parsed.cardName), kind: 'balance',
      reported: parsed.balance, computed: '', diff: '',
      status: 'pending', rawMessageId: rawId,
    });
  }
  if (parsed.cumulative !== null && parsed.cumulative !== undefined) {
    append_('Anchor', {
      id: newId_('anc'), at: toIso_(parsed.occurredAt),
      accountId: accountFor_(parsed.issuer, parsed.cardName), kind: 'cumulative',
      reported: parsed.cumulative, computed: '', diff: '',
      status: 'pending', rawMessageId: rawId,
    });
  }
}

/** 알림 메뉴에 올릴 카테고리 후보. 최근에 많이 쓴 순. */
function topCategories_(n) {
  const counts = {};
  readAll_('Transaction').forEach(function (t) {
    if (!t.categoryId) return;
    counts[t.categoryId] = (counts[t.categoryId] || 0) + 1;
  });
  const categories = readAll_('Category').filter(function (c) { return c.kind === 'expense'; });
  categories.sort(function (a, b) { return (counts[b.id] || 0) - (counts[a.id] || 0); });
  return categories.slice(0, n).map(function (c) {
    return { id: c.id, name: c.name, icon: c.icon };
  });
}

/**
 * 파서를 고친 뒤 과거 문자를 다시 돌린다.
 * 원문을 무손실로 보관하는 이유가 이것이다.
 */
function reprocessAll(fromVersion) {
  const target = fromVersion === undefined ? CONFIG.parserVersion : fromVersion;
  const rows = readAll_('RawMessage').filter(function (r) {
    return Number(r.parserVersion) < target || r.parsedOk !== true;
  });

  let nowParsed = 0;
  let created = 0;

  rows.forEach(function (r) {
    const parsed = parseMessage_(r.body, r.sender, new Date(r.receivedAt));
    update_('RawMessage', r.id, {
      parserVersion: CONFIG.parserVersion,
      parsedOk: parsed.ok,
      parseNote: parsed.note,
    });
    if (!parsed.ok) return;
    nowParsed++;

    // 이미 거래가 달린 문자는 건드리지 않는다. 두 번 세면 안 된다.
    if (r.txnId) return;
    if (parsed.kind === 'ad') return;

    // 좌표는 수집 시점에만 얻을 수 있어 재처리로는 되살릴 수 없다
    const result = materialize_(parsed, r.id, null);
    if (result.txnId) created++;
  });

  Logger.log('훑은 문자 ' + rows.length + '건 · 이제 읽힘 ' + nowParsed +
             '건 · 새로 만든 거래 ' + created + '건');
  return { scanned: rows.length, nowParsed: nowParsed, created: created };
}
