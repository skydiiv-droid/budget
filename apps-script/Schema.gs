/**
 * 시트 스키마. 한 시트 = 한 테이블, 1행은 헤더.
 *
 * setup()을 한 번 실행하면 없는 시트를 만들고 헤더와 시드 데이터를 넣는다.
 * 이미 있는 시트는 건드리지 않으므로 여러 번 실행해도 안전하다.
 */

const SCHEMA = {
  // 문자 원문. 무손실 보관 — 파서를 고친 뒤 여기서 전부 재처리한다.
  RawMessage: ['id', 'receivedAt', 'sender', 'body', 'dedupeKey',
               'parserVersion', 'parsedOk', 'parseNote', 'txnId', 'ingestedAt'],

  // 거래 1건 = "무엇을 언제 샀나". 금액은 전액(할부여도 전액).
  Transaction: ['id', 'type', 'amount', 'currency', 'occurredAt',
                'accountId', 'counterAccountId', 'categoryId', 'tags',
                'merchantRaw', 'merchantId', 'memo',
                'payMethod', 'installmentMonths',
                'status', 'voidsTxnId', 'voidedByTxnId',
                'source', 'rawMessageId', 'dedupeKey', 'excludeFromBudget'],

  // 청구 스케줄 = "언제 얼마가 나가나". 일시불 1건, 3개월 할부 3건, 리볼빙은 매달 재생성.
  PaymentSchedule: ['id', 'txnId', 'accountId', 'dueDate', 'amount',
                    'seq', 'kind', 'settled', 'settledTxnId'],

  // 계좌와 카드 둘 다 "계정". 카드값은 지출이 아니라 계정 간 이체다.
  Account: ['id', 'name', 'type', 'issuer', 'last4',
            'closingDay', 'billingDay', 'active'],

  Category: ['id', 'name', 'parentId', 'kind', 'icon', 'sortOrder'],
  Tag: ['id', 'name'],

  Merchant: ['id', 'normalizedName', 'displayName', 'defaultCategoryId',
             'isPassthrough', 'alwaysAsk', 'aliases', 'hitCount'],

  // 분류 규칙. source=learned 는 사용자 교정에서 자동 생성된 것.
  Rule: ['id', 'priority', 'matchType', 'pattern', 'categoryId',
         'source', 'hitCount', 'lastUsedAt'],

  // 문자 패턴 테이블. 실제 문자 샘플이 생기면 여기에 정규식을 추가한다.
  // 코드를 고치지 않고 시트에서 편집 -> 즉시 반영.
  Pattern: ['id', 'issuer', 'kind', 'priority', 'regex', 'fields', 'enabled', 'note'],

  // 잔액/누적 앵커. 문자에 찍힌 값과 앱 계산값을 대조해 누락을 잡는다.
  Anchor: ['id', 'at', 'accountId', 'kind', 'reported', 'computed', 'diff',
           'status', 'rawMessageId'],

  Settings: ['key', 'value'],
};

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SCHEMA).forEach(function (name) {
    let sheet = ss.getSheetByName(name);
    if (sheet) return;
    sheet = ss.insertSheet(name);
    const headers = SCHEMA[name];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  });
  seedCategories_();
  seedTags_();
  seedAccounts_();
  SpreadsheetApp.getActiveSpreadsheet().toast('시트 준비 완료');
}

function sheet_(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('시트 없음: ' + name + ' — setup()을 먼저 실행하세요.');
  return sheet;
}

/** 시트를 객체 배열로 읽는다. */
function readAll_(name) {
  const sheet = sheet_(name);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1).map(function (row) {
    const obj = {};
    headers.forEach(function (h, i) { obj[h] = row[i]; });
    return obj;
  });
}

/** 객체 하나를 헤더 순서에 맞춰 덧붙인다. */
function append_(name, obj) {
  const sheet = sheet_(name);
  const headers = SCHEMA[name];
  sheet.appendRow(headers.map(function (h) {
    const v = obj[h];
    return (v === undefined || v === null) ? '' : v;
  }));
  return obj;
}

/** id로 한 행을 찾아 일부 필드만 갱신한다. */
function update_(name, id, patch) {
  const sheet = sheet_(name);
  const headers = SCHEMA[name];
  const values = sheet.getDataRange().getValues();
  const idCol = headers.indexOf('id');
  for (let r = 1; r < values.length; r++) {
    if (values[r][idCol] !== id) continue;
    Object.keys(patch).forEach(function (key) {
      const c = headers.indexOf(key);
      if (c >= 0) sheet.getRange(r + 1, c + 1).setValue(patch[key]);
    });
    return true;
  }
  return false;
}

function findBy_(name, field, value) {
  const rows = readAll_(name);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][field] === value) return rows[i];
  }
  return null;
}
