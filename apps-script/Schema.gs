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
  // 계좌·카드·현금·저축. balance 는 지금 남은 돈.
  // 은행 문자에 잔액이 찍히면 알아서 갱신된다.
  Account: ['id', 'name', 'type', 'issuer', 'last4',
            'closingDay', 'billingDay', 'balance', 'balanceAt', 'active'],

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

  // 매달 나가는 돈. 구독·통신비·보험료.
  // 실제 결제도 카드 문자로 들어오므로, 집계할 때 둘을 겹쳐 세지 않도록
  // Ledger가 가맹점 이름으로 짝을 지어 변동지출에서 뺀다.
  RecurringRule: ['id', 'name', 'expectedAmount', 'dayOfMonth',
                  'accountId', 'categoryId', 'autoDetected', 'lastMatchedTxnId'],

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
  if (made) { SpreadsheetApp.flush(); SS_ = null; invalidate_(); }
  return made;
}

/**
 * 스프레드시트 핸들.
 *
 * 스크립트가 시트에 붙어 있지 않으면(따로 만든 프로젝트) getActiveSpreadsheet()가
 * 비어 온다. 그때는 무엇이 잘못됐는지 알려 주고 멈춘다 — 엉뚱한 곳에 쓰는 것보다
 * 낫다. SHEET_ID 스크립트 속성이 있으면 그 파일을 쓴다.
 */
var SS_ = null;

function spreadsheet_() {
  // 핸들을 받는 것도, 속성을 읽는 것도 공짜가 아니다.
  // sheet_() 가 부를 때마다 새로 받으면 그만큼 느려진다.
  if (SS_) return SS_;

  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (id) { SS_ = SpreadsheetApp.openById(id); return SS_; }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) { SS_ = ss; return SS_; }

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

/**
 * 한 번 실행되는 동안만 살아 있는 캐시.
 *
 * 시트 한 번 읽기가 이 앱에서 가장 비싼 일이다. 그런데 대시보드를 한 번
 * 여는 것만으로 Transaction 전체를 미분류 건수 × 3번씩 읽고 있었다 —
 * 위치를 보고, 브랜드 낱말을 찾고, 자주 쓴 카테고리를 세느라 각자 읽었다.
 *
 * 같은 요청 안에서는 시트가 바뀌지 않으므로 한 번만 읽는다.
 * 쓰기가 일어난 시트만 비운다.
 */
var SHEET_CACHE_ = {};

function invalidate_(name) {
  if (name) delete SHEET_CACHE_[name];
  else SHEET_CACHE_ = {};
}

/**
 * 여러 시트를 한 번에 읽어 캐시에 담는다.
 *
 * 시트 한 번 읽기는 행 수와 상관없이 200~800ms 든다. 0행짜리도 마찬가지다.
 * 그래서 비용은 데이터 양이 아니라 호출 횟수에 붙는다. 화면 한 번 여는 데
 * 아홉 시트를 읽으면 그것만 2초가 넘는다.
 *
 * Sheets 고급 서비스를 켜 두면 batchGet 한 번으로 전부 가져온다.
 * 켜지 않았으면 조용히 넘어가고 평소처럼 하나씩 읽는다.
 *
 * 켜는 법: 편집기 왼쪽 "서비스" + → Google Sheets API → 추가
 */
function preload_(names) {
  if (typeof Sheets === 'undefined') return false;

  const wanted = names.filter(function (n) { return SCHEMA[n] && !SHEET_CACHE_[n]; });
  if (!wanted.length) return true;

  let response;
  try {
    response = Sheets.Spreadsheets.Values.batchGet(spreadsheet_().getId(), { ranges: wanted });
  } catch (e) {
    return false;   // 고급 서비스가 없거나 권한이 없으면 평소대로
  }

  (response.valueRanges || []).forEach(function (vr) {
    // 돌아온 range 는 "Transaction!A1:U4" 또는 "'이름'!A1:B2" 꼴이다
    const name = String(vr.range || '').split('!')[0].replace(/^'|'$/g, '');
    if (!SCHEMA[name]) return;

    const values = vr.values || [];
    if (values.length < 2) { SHEET_CACHE_[name] = []; return; }

    const headers = values[0];
    SHEET_CACHE_[name] = values.slice(1).map(function (row) {
      const obj = {};
      headers.forEach(function (h, i) { obj[h] = row[i] === undefined ? '' : row[i]; });
      return obj;
    });
  });

  // batchGet 은 아예 빈 시트를 빠뜨리기도 한다. 그것도 읽은 것으로 친다.
  wanted.forEach(function (n) { if (!SHEET_CACHE_[n]) SHEET_CACHE_[n] = []; });
  return true;
}

/**
 * 시트를 객체 배열로 읽는다.
 *
 * 돌려주는 배열은 캐시와 같은 것이다. 부르는 쪽에서 고치면 안 된다 —
 * 행을 고칠 때는 update_ 를 쓴다.
 */
function readAll_(name) {
  if (SHEET_CACHE_[name]) return SHEET_CACHE_[name];

  const values = sheet_(name).getDataRange().getValues();
  let rows = [];
  if (values.length >= 2) {
    const headers = values[0];
    rows = values.slice(1).map(function (row) {
      const obj = {};
      headers.forEach(function (h, i) { obj[h] = row[i]; });
      return obj;
    });
  }
  SHEET_CACHE_[name] = rows;
  return rows;
}

/** 객체 하나를 헤더 순서에 맞춰 덧붙인다. */
function append_(name, obj) {
  const sheet = sheet_(name);
  const headers = SCHEMA[name];
  sheet.appendRow(headers.map(function (h) {
    const v = obj[h];
    return (v === undefined || v === null) ? '' : v;
  }));
  invalidate_(name);
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
    invalidate_(name);
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
