/**
 * 웹앱 진입점.
 *
 *   POST  {action:"ingest",     token, body, sender, receivedAt, lat, lon, placeName}
 *   POST  {action:"categorize", token, txnId, choice, scopeChoice?}
 *   POST  {action:"forgetRule",  token, pattern}
 *   POST  {action:"manual",     token, amount, categoryId, memo, occurredAt}
 *   POST  {action:"split",      token, txnId, headcount | expectedAmount}
 *   POST  {action:"splitLink",  token, settlementId, incomeTxnId}
 *   GET   ?token=...             -> 대시보드 (M3)
 *
 * 배포: 배포 > 새 배포 > 웹 앱
 *   실행 주체 = 나,  액세스 권한 = 모든 사용자
 * URL을 아는 누구나 POST할 수 있으므로 토큰 검증이 유일한 방어선이다.
 */

function doPost(e) {
  let payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ status: 'error', reason: 'bad-json' });
  }

  if (payload.token !== getIngestToken_()) {
    return jsonResponse_({ status: 'error', reason: 'unauthorized' });
  }

  // 문자가 몰려 들어올 때 행이 덮어써지는 걸 막는다
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return jsonResponse_({ status: 'error', reason: 'busy' });
  }

  try {
    switch (payload.action) {
      case 'ingest':
        return jsonResponse_(ingest(payload));
      case 'categorize':
        return jsonResponse_(categorize(payload));
      case 'manual':
        return jsonResponse_(manualEntry(payload));
      case 'split':
        return jsonResponse_(openSettlement(payload));
      case 'splitLink':
        return jsonResponse_(linkSettlement(payload));
      case 'forgetRule':
        return jsonResponse_(forgetRule(payload));
      default:
        return jsonResponse_({ status: 'error', reason: 'unknown-action' });
    }
  } catch (err) {
    return jsonResponse_({ status: 'error', reason: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  if (!e || !e.parameter || e.parameter.token !== getIngestToken_()) {
    return HtmlService.createHtmlOutput('<p>접근 권한이 없습니다.</p>');
  }
  // 대시보드는 M3. 지금은 수집이 살아 있는지만 확인한다.
  const raw = readAll_('RawMessage');
  const txns = readAll_('Transaction');
  const pending = txns.filter(function (t) { return t.status === 'pendingCategory'; });
  const failed = raw.filter(function (r) { return r.parsedOk !== true; });
  const last = raw.length ? raw[raw.length - 1].receivedAt : '없음';
  const openSplits = readAll_('Settlement').filter(function (s) { return s.status === 'open'; });
  const outstanding = openSplits.reduce(function (sum, s) {
    return sum + (Number(s.expectedAmount) - Number(s.receivedAmount || 0));
  }, 0);

  return HtmlService.createHtmlOutput(
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<div style="font:16px/1.6 -apple-system,sans-serif;padding:24px">' +
    '<h2>수집 상태</h2>' +
    '<p>받은 문자 <b>' + raw.length + '</b>건</p>' +
    '<p>거래 <b>' + txns.length + '</b>건</p>' +
    '<p>미분류 <b>' + pending.length + '</b>건</p>' +
    '<p>해석 실패 <b>' + failed.length + '</b>건</p>' +
    '<p>미회수 더치페이 <b>' + openSplits.length + '</b>건 · ' +
        outstanding.toLocaleString() + '원</p>' +
    '<p>마지막 수신 <b>' + last + '</b></p>' +
    '</div>'
  );
}

/**
 * 아이폰 알림 메뉴에서 카테고리를 고르면 호출된다.
 *
 * scope 로 규칙을 걸 범위를 정한다.
 *   once     이 건만
 *   exact    이름이 똑같은 곳만
 *   contains keyword 가 들어간 모든 곳   (프랜차이즈 지점명 대응)
 *
 * scope 를 주지 않으면 서버가 권하는 범위를 쓴다.
 */
function categorize(payload) {
  const txn = findBy_('Transaction', 'id', payload.txnId);
  if (!txn) return { status: 'error', reason: 'txn-not-found' };

  // 단축어는 메뉴에서 고른 글자("☕ 카페")를 그대로 보낸다. id를 몰라도 된다.
  const categoryId = resolveCategory_(payload.choice || payload.categoryId);
  if (!categoryId) {
    return { status: 'error', reason: 'category-not-found', given: payload.choice || payload.categoryId };
  }

  update_('Transaction', txn.id, { categoryId: categoryId, status: 'confirmed' });

  const chosen = parseScopeChoice_(payload.scopeChoice, txn.merchantRaw);
  const scope = payload.scope || chosen.scope;
  const keyword = payload.keyword || chosen.keyword;

  const learned = learn_(txn.merchantRaw, categoryId, scope, keyword);

  // 규칙을 만들었으면 밀려 있던 같은 가게 건들도 함께 정리한다
  const alsoFixed = applyToPending_(categoryId, learned.scope, learned.keyword);

  return {
    status: 'ok',
    txnId: txn.id,
    categoryId: categoryId,
    learned: learned,
    alsoFixed: alsoFixed,
    message: confirmMessage_(categoryId, learned, alsoFixed),
  };
}

/** 카드 밖의 지출(현금 등)을 손으로 넣는다. */
function manualEntry(payload) {
  const txn = {
    id: newId_('txn'),
    type: payload.type || 'expense',
    amount: parseAmount_(payload.amount),
    currency: 'KRW',
    occurredAt: payload.occurredAt || nowIso_(),
    accountId: payload.accountId || 'acc_cash',
    counterAccountId: '',
    categoryId: payload.categoryId || '',
    merchantRaw: payload.merchant || '',
    merchantId: '',
    memo: payload.memo || '',
    payMethod: 'lump',
    installmentMonths: 0,
    status: payload.categoryId ? 'confirmed' : 'pendingCategory',
    voidsTxnId: '',
    voidedByTxnId: '',
    source: 'manual',
    rawMessageId: '',
    dedupeKey: '',
    excludeFromBudget: false,
    lat: payload.lat || '',
    lon: payload.lon || '',
    placeName: payload.placeName || '',
    settlementId: '',
  };
  append_('Transaction', txn);
  return { status: 'ok', txnId: txn.id };
}
