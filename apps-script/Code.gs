/**
 * 웹앱 진입점.
 *
 *   POST  {action:"ingest",    token, body, sender, receivedAt}
 *   POST  {action:"categorize",token, txnId, categoryId}
 *   POST  {action:"manual",    token, amount, categoryId, memo, occurredAt}
 *   GET   ?token=...            -> 대시보드 (M3)
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

  return HtmlService.createHtmlOutput(
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<div style="font:16px/1.6 -apple-system,sans-serif;padding:24px">' +
    '<h2>수집 상태</h2>' +
    '<p>받은 문자 <b>' + raw.length + '</b>건</p>' +
    '<p>거래 <b>' + txns.length + '</b>건</p>' +
    '<p>미분류 <b>' + pending.length + '</b>건</p>' +
    '<p>해석 실패 <b>' + failed.length + '</b>건</p>' +
    '<p>마지막 수신 <b>' + last + '</b></p>' +
    '</div>'
  );
}

/** 아이폰 알림 메뉴에서 카테고리를 고르면 호출된다. */
function categorize(payload) {
  const txn = findBy_('Transaction', 'id', payload.txnId);
  if (!txn) return { status: 'error', reason: 'txn-not-found' };

  update_('Transaction', txn.id, {
    categoryId: payload.categoryId,
    status: 'confirmed',
  });
  learn_(txn.merchantRaw, payload.categoryId);
  return { status: 'ok', txnId: txn.id, categoryId: payload.categoryId };
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
    tags: payload.tags || '',
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
  };
  append_('Transaction', txn);
  return { status: 'ok', txnId: txn.id };
}
