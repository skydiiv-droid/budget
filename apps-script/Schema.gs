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
  // lat/lon은 결제 직후 문자가 오므로 사실상 가맹점 좌표다.
  // 가맹점명이 "네이버파이낸셜"로 뭉개져도 좌표는 안 뭉개진다.
  Transaction: ['id', 'type', 'amount', 'currency', 'occurredAt',
                'accountId', 'counterAccountId', 'categoryId',
                'merchantRaw', 'merchantId', 'memo',
                'payMethod', 'installmentMonths',
                'status', 'voidsTxnId', 'voidedByTxnId',
                'source', 'rawMessageId', 'dedupeKey', 'excludeFromBudget',
                'lat', 'lon', 'placeName', 'settlementId'],

  // 청구 스케줄 = "언제 얼마가 나가나". 일시불 1건, 3개월 할부 3건, 리볼빙은 매달 재생성.
  PaymentSchedule: ['id', 'txnId', 'accountId', 'dueDate', 'amount',
                    'seq', 'kind', 'settled', 'settledTxnId'],

  // 계좌와 카드 둘 다 "계정". 카드값은 지출이 아니라 계정 간 이체다.
  Account: ['id', 'name', 'type', 'issuer', 'last4',
            'closingDay', 'billingDay', 'active'],

  Category: ['id', 'name', 'parentId', 'kind', 'icon', 'sortOrder'],

  // 더치페이 정산. 지출 1건 <- 회수 입금 N건.
  // 보내는 사람마다 금액이 달라서(23,450 요청에 23,500/24,000) 허용 오차로 닫는다.
  Settlement: ['id', 'txnId', 'expectedAmount', 'receivedAmount', 'tolerance',
               'status', 'note', 'createdAt', 'closedAt'],
  SettlementLink: ['id', 'settlementId', 'incomeTxnId', 'amount', 'linkedAt', 'note'],

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

  // 빚. 이자율이 높은 것부터 갚아야 총 이자가 가장 적다.
  Debt: ['id', 'name', 'kind', 'balance', 'rate', 'billingDay', 'note', 'sortOrder'],

  Settings: ['key', 'value'],
};

/**
 * 없는 시트를 만든다. 있는 시트는 건드리지 않는다.
 *
 * 스키마에 시트가 새로 생기면(Debt 처럼) 기존 사용자에게는 그 시트가 없다.
 * setup() 과 resync() 가 둘 다 이걸 먼저 부르므로, 어느 쪽을 실행하든
 * 시트가 없어서 실패하는 일은 없다.
 */
function ensureSheets_() {
  const ss = spreadsheet_();
  let made = 0;
  Object.keys(SCHEMA).forEach(function (name) {
    if (ss.getSheetByName(name)) return;
    const sheet = ss.insertSheet(name);
    const headers = SCHEMA[name];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    made++;
  });
  // 만든 시트가 곧바로 보이도록 쓰기를 밀어낸다.
  // 이걸 안 하면 방금 만든 시트를 바로 뒤에서 못 찾는 일이 있다.
  if (made) SpreadsheetApp.flush();
  return made;
}

/**
 * 스프레드시트 핸들.
 *
 * 스크립트가 시트에 붙어 있지 않으면(따로 만든 프로젝트) getActiveSpreadsheet()가
 * 비어 온다. 그때는 무엇이 잘못됐는지 알려 주고 멈춘다 — 엉뚱한 곳에 쓰는 것보다
 * 낫다. SHEET_ID 스크립트 속성이 있으면 그 파일을 쓴다.
 */
function spreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) return ss;

  throw new Error('스프레드시트를 찾을 수 없습니다. 스크립트가 시트에 붙어 있지 않은 것 같아요. ' +
                  '프로젝트 설정 > 스크립트 속성에 SHEET_ID 로 시트 주소의 /d/ 와 /edit 사이 값을 넣어 주세요.');
}

function setup() {
  ensureSheets_();
  seedCategories_();
  seedAccounts_();
  seedRules_();
  seedMerchants_();
  seedSettings_();
  spreadsheet_().toast('시트 준비 완료');
}

function sheet_(name) {
  let sheet = spreadsheet_().getSheetByName(name);
  if (sheet) return sheet;

  // 스키마에 있는 시트인데 없다면 만들어 준다. 새 시트가 추가됐을 때
  // 사용자가 어느 함수를 먼저 돌려야 하는지 알아야 할 이유가 없다.
  if (SCHEMA[name]) {
    ensureSheets_();
    // 핸들을 다시 받는다. 앞서 받아 둔 것은 방금 만든 시트를 모른다.
    sheet = spreadsheet_().getSheetByName(name);
    if (sheet) return sheet;
  }
  throw new Error('시트를 만들 수 없습니다: ' + name +
                  ' — 편집기에서 diagnose() 를 실행해 로그를 확인해 주세요.');
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
