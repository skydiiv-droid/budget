/**
 * 이 파일은 build.js가 생성합니다. 직접 고치지 마세요.
 * 원본: apps-script/*.gs
 *
 * 사용법: 전체를 복사해 Apps Script 편집기의 Code.gs에 붙여넣으세요.
 */
// ===== Config.gs                                                   =====

/**
 * 전역 설정.
 *
 * 비밀값(수집 토큰)은 코드에 두지 않고 스크립트 속성에 둔다.
 *   Apps Script 편집기 > 프로젝트 설정 > 스크립트 속성
 *     INGEST_TOKEN = <아무 긴 랜덤 문자열>
 */
const CONFIG = {
  timezone: 'Asia/Seoul',

  // 한 달 사이클 시작일. 1이면 1일~말일.
  cycleStartDay: 1,

  // 파서 버전. 패턴을 고칠 때마다 올린다.
  // RawMessage에 기록해두고, 구버전으로 파싱된 문자만 골라 재처리한다.
  parserVersion: 1,

  // 승인취소 문자가 원거래를 찾을 때 거슬러 올라가는 기간
  voidMatchWindowDays: 60,

  // 은행 출금과 카드 승인이 같은 거래일 때 짝을 찾는 시간 허용 오차
  crossMatchWindowMinutes: 2,
};

function getIngestToken_() {
  const token = PropertiesService.getScriptProperties().getProperty('INGEST_TOKEN');
  if (!token) throw new Error('스크립트 속성 INGEST_TOKEN이 없습니다.');
  return token;
}

// ===== Util.gs                                                     =====

/** 공통 유틸. */

function newId_(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

/** 같은 문자가 두 번 들어와도 한 건으로 취급하기 위한 키. */
function dedupeKey_(body, receivedAt) {
  const minute = Utilities.formatDate(receivedAt, CONFIG.timezone, 'yyyyMMddHHmm');
  const raw = minute + '|' + body;
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function nowIso_() {
  return Utilities.formatDate(new Date(), CONFIG.timezone, "yyyy-MM-dd'T'HH:mm:ss");
}

function toIso_(date) {
  return Utilities.formatDate(date, CONFIG.timezone, "yyyy-MM-dd'T'HH:mm:ss");
}

/** "1,234,567" / "1234567" -> 1234567 (원 단위 정수) */
function parseAmount_(text) {
  if (text === null || text === undefined) return null;
  const digits = String(text).replace(/[^\d-]/g, '');
  if (!digits) return null;
  return parseInt(digits, 10);
}

/**
 * 문자에 찍힌 날짜/시각을 올해 기준 Date로 만든다.
 * 카드/은행 문자는 연도를 안 적으므로 수신 시각을 기준으로 보정한다.
 * (12/31 문자를 1/1에 받는 경우가 있어 한 달 이상 미래면 작년으로 내린다)
 */
function resolveDate_(month, day, hour, minute, receivedAt) {
  if (!month || !day) return receivedAt;
  let year = Number(Utilities.formatDate(receivedAt, CONFIG.timezone, 'yyyy'));
  let d = new Date(year, month - 1, day, hour || 0, minute || 0);
  if (d.getTime() - receivedAt.getTime() > 31 * 24 * 3600 * 1000) {
    d = new Date(year - 1, month - 1, day, hour || 0, minute || 0);
  }
  return d;
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== Schema.gs                                                   =====

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

// ===== Seed.gs                                                     =====

/** 초기 데이터. 이미 행이 있으면 건드리지 않는다. */

const SEED_CATEGORIES = [
  // [id, 이름, 상위, 종류, 아이콘]
  ['cat_delivery',   '배달',     '',            'expense', '🛵'],
  ['cat_dining',     '외식',     '',            'expense', '🍚'],
  ['cat_cafe',       '카페',     'cat_dining',  'expense', '☕'],
  ['cat_grocery',    '마트',     '',            'expense', '🛒'],
  ['cat_convenience','편의점',   '',            'expense', '🏪'],
  ['cat_transport',  '교통',     '',            'expense', '🚌'],
  ['cat_medical',    '의료',     '',            'expense', '🏥'],
  ['cat_beauty',     '미용',     '',            'expense', '💇'],
  ['cat_shopping',   '쇼핑',     '',            'expense', '🛍️'],
  ['cat_hobby',      '취미',     '',            'expense', '🎨'],
  ['cat_travel',     '여행',     '',            'expense', '✈️'],
  ['cat_gathering',  '모임',     '',            'expense', '🍻'],

  // 매달 자동으로 나가는 것들. 고정지출 화면이 이 세 개를 본다.
  ['cat_subscription','구독',    '',            'expense', '📺'],
  ['cat_sub_digital','디지털',   'cat_subscription', 'expense', '☁️'],  // 아이클라우드·구글드라이브·클로드
  ['cat_sub_media',  '미디어',   'cat_subscription', 'expense', '🎬'],  // 넷플릭스 등
  ['cat_telecom',    '통신',     '',            'expense', '📱'],
  ['cat_donation',   '기부',     '',            'expense', '💗'],

  ['cat_event',      '경조사',   '',            'expense', '🎁'],
  ['cat_finance',    '금융비용', '',            'expense', '💸'],
  ['cat_etc',        '기타',     '',            'expense', '📦'],
  ['cat_unknown',    '미분류',   '',            'expense', '❓'],

  ['cat_salary',     '급여',     '',            'income',  '💰'],
  // 더치페이로 돌려받은 돈. 진짜 수입이 아니라 지출 환급이라
  // 수입 합계에서 빼고 원 지출과 상계한다.
  ['cat_settle_in',  '정산입금', '',            'income',  '🔁'],

  // 이체는 지출이 아니다. 예산·통계에서 제외된다.
  ['cat_cardbill',   '카드대금', '',            'transfer', '💳'],
  ['cat_saving',     '저축투자', '',            'transfer', '🏦'],
  ['cat_withdraw',   '현금인출', '',            'transfer', '🏧'],
];

const SEED_ACCOUNTS = [
  // [id, 이름, 종류, 발급사, 뒷자리, 마감일, 결제일]
  ['acc_woori',   '우리은행',   'checking', '우리은행',  '', '', ''],
  ['acc_hyundai', '현대카드',   'card',     '현대카드',  '', '', 5],
  ['acc_cash',    '현금',       'cash',     '',          '', '', ''],
];

function seedCategories_() {
  if (readAll_('Category').length) return;
  SEED_CATEGORIES.forEach(function (row, i) {
    append_('Category', {
      id: row[0], name: row[1], parentId: row[2],
      kind: row[3], icon: row[4], sortOrder: i,
    });
  });
}

function seedAccounts_() {
  if (readAll_('Account').length) return;
  SEED_ACCOUNTS.forEach(function (row) {
    append_('Account', {
      id: row[0], name: row[1], type: row[2], issuer: row[3],
      last4: row[4], closingDay: row[5], billingDay: row[6], active: true,
    });
  });
}

// ===== Parse.gs                                                    =====

/**
 * 문자 파서 — 3계층.
 *
 *   Layer 1  제네릭 추출기 : 샘플이 하나도 없어도 동작하는 휴리스틱.
 *   Layer 2  패턴 테이블   : Pattern 시트의 정규식. 있으면 이쪽이 우선.
 *   Layer 3  교정 학습     : 인박스에서 고친 결과로 패턴 후보를 만든다. (M2)
 *
 * 어느 계층도 못 읽으면 실패로 두고 RawMessage만 남긴다.
 * 파싱 실패는 에러가 아니라 정상 상태다 — 인박스에서 사람이 처리한다.
 */

const KEYWORDS = {
  approval:   ['승인', '결제'],
  cancel:     ['취소'],
  installment:['개월'],
  lumpSum:    ['일시불'],
  withdrawal: ['출금', '지급'],
  deposit:    ['입금'],
  balance:    ['잔액'],
  cumulative: ['누적'],
  ad:         ['(광고)', '[광고]', '광고)'],
};

/** 금액 앞에 붙는 라벨 -> 역할. 앞쪽(최대 8자)을 훑어 판정한다. */
const AMOUNT_LABELS = [
  { role: 'balance',    words: ['잔액'] },
  { role: 'cumulative', words: ['누적'] },
  { role: 'amount',     words: ['승인', '결제', '출금', '입금', '지급', '사용'] },
];

function parseMessage_(body, sender, receivedAt) {
  const text = String(body || '').trim();
  const result = {
    ok: false,
    note: '',
    issuer: detectIssuer_(text, sender),
    kind: null,           // approval | cancel | withdrawal | deposit | ad | unknown
    amount: null,
    balance: null,        // 우리은행 잔액 앵커
    cumulative: null,     // 현대카드 월 누적 앵커
    occurredAt: null,
    merchantRaw: null,
    installmentMonths: 0,
    confidence: 0,
    layer: null,
  };

  if (hasAny_(text, KEYWORDS.ad)) {
    result.kind = 'ad';
    result.ok = true;
    result.note = '광고 문자 — 거래 생성 안 함';
    result.layer = 'keyword';
    return result;
  }

  const byPattern = applyPatterns_(text, result.issuer);
  if (byPattern) {
    Object.keys(byPattern).forEach(function (k) { result[k] = byPattern[k]; });
    result.layer = 'pattern';
    result.confidence = 1.0;
  } else {
    applyGeneric_(text, result);
    result.layer = 'generic';
  }

  if (!result.occurredAt) result.occurredAt = receivedAt;

  result.ok = result.kind !== null && result.kind !== 'unknown' && result.amount !== null;
  if (!result.ok && !result.note) {
    result.note = result.amount === null ? '금액을 못 찾음' : '거래 종류를 못 정함';
  }
  return result;
}

// ---------------------------------------------------------------- Layer 2

/**
 * Pattern 시트의 정규식을 우선순위대로 적용한다.
 * fields는 캡처 그룹 번호 -> 필드명 매핑 (JSON).
 *   예) {"1":"month","2":"day","3":"hour","4":"minute","5":"amount","6":"merchantRaw"}
 */
function applyPatterns_(text, issuer) {
  let patterns;
  try {
    patterns = readAll_('Pattern');
  } catch (e) {
    return null;   // 시트가 아직 없을 수 있다
  }

  const candidates = patterns
    .filter(function (p) { return p.enabled === true || p.enabled === 'TRUE'; })
    .filter(function (p) { return !p.issuer || p.issuer === issuer; })
    .sort(function (a, b) { return (Number(a.priority) || 0) - (Number(b.priority) || 0); });

  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i];
    let re, match;
    try {
      re = new RegExp(p.regex);
      match = re.exec(text);
    } catch (e) {
      continue;   // 잘못 적은 정규식은 건너뛴다
    }
    if (!match) continue;

    const fields = JSON.parse(p.fields || '{}');
    const out = { kind: p.kind };
    const parts = {};
    Object.keys(fields).forEach(function (groupIdx) {
      parts[fields[groupIdx]] = match[Number(groupIdx)];
    });

    if (parts.amount !== undefined)     out.amount = parseAmount_(parts.amount);
    if (parts.balance !== undefined)    out.balance = parseAmount_(parts.balance);
    if (parts.cumulative !== undefined) out.cumulative = parseAmount_(parts.cumulative);
    if (parts.merchantRaw !== undefined) out.merchantRaw = String(parts.merchantRaw).trim();
    if (parts.installmentMonths !== undefined) {
      out.installmentMonths = parseAmount_(parts.installmentMonths) || 0;
    }
    return out;
  }
  return null;
}

// ---------------------------------------------------------------- Layer 1

function applyGeneric_(text, result) {
  result.kind = detectKind_(text);

  const amounts = extractAmounts_(text);
  amounts.forEach(function (a) {
    if (a.role === 'balance' && result.balance === null) result.balance = a.value;
    else if (a.role === 'cumulative' && result.cumulative === null) result.cumulative = a.value;
    else if (a.role === 'amount' && result.amount === null) result.amount = a.value;
  });

  // 라벨이 없는 숫자만 있을 때: 잔액/누적으로 안 잡힌 첫 번째를 거래 금액으로 본다.
  if (result.amount === null) {
    for (let i = 0; i < amounts.length; i++) {
      if (amounts[i].role === 'unknown') { result.amount = amounts[i].value; break; }
    }
  }

  const when = extractDateTime_(text);
  if (when) result.occurredAt = when;

  const months = /(\d{1,2})\s*개월/.exec(text);
  if (months) result.installmentMonths = Number(months[1]);

  result.merchantRaw = extractMerchant_(text);

  // 휴리스틱이라 신뢰도를 낮게 잡아둔다. 인박스에서 한 번 확인받는 편이 낫다.
  // Layer 2(패턴)만 1.0을 받는다. 제네릭은 아무리 잘 뽑아도 0.9에서 멈춘다.
  let score = 0;
  if (result.amount !== null) score += 0.5;
  if (result.kind && result.kind !== 'unknown') score += 0.2;
  if (result.merchantRaw) score += 0.2;
  if (result.occurredAt) score += 0.1;
  result.confidence = Math.round(Math.min(score, 0.9) * 100) / 100;
}

function detectIssuer_(text, sender) {
  const haystack = String(sender || '') + ' ' + text;
  if (/현대\s*카드|현대카드/.test(haystack)) return '현대카드';
  if (/우리\s*은행|우리은행|\[우리\]/.test(haystack)) return '우리은행';
  return '';
}

function detectKind_(text) {
  // 취소를 승인보다 먼저 본다 — "승인취소"에는 둘 다 들어 있다.
  if (hasAny_(text, KEYWORDS.cancel)) return 'cancel';
  if (hasAny_(text, KEYWORDS.approval)) return 'approval';
  if (hasAny_(text, KEYWORDS.deposit)) return 'deposit';
  if (hasAny_(text, KEYWORDS.withdrawal)) return 'withdrawal';
  return 'unknown';
}

/** 문자 안의 모든 금액을 찾아 앞 라벨로 역할을 붙인다. */
function extractAmounts_(text) {
  const out = [];
  const re = /(\d{1,3}(?:,\d{3})+|\d{3,})\s*원?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const value = parseAmount_(m[1]);
    if (value === null) continue;
    const before = text.slice(Math.max(0, m.index - 8), m.index);
    out.push({ value: value, role: roleOf_(before), index: m.index });
  }
  return out;
}

function roleOf_(before) {
  for (let i = 0; i < AMOUNT_LABELS.length; i++) {
    const label = AMOUNT_LABELS[i];
    for (let j = 0; j < label.words.length; j++) {
      if (before.indexOf(label.words[j]) >= 0) return label.role;
    }
  }
  return 'unknown';
}

/** MM/DD, MM.DD, MM월DD일 + HH:MM */
function extractDateTime_(text) {
  const date = /(\d{1,2})[\/\.월](\d{1,2})일?/.exec(text);
  const time = /(\d{1,2}):(\d{2})/.exec(text);
  if (!date && !time) return null;
  return resolveDate_(
    date ? Number(date[1]) : null,
    date ? Number(date[2]) : null,
    time ? Number(time[1]) : 0,
    time ? Number(time[2]) : 0,
    new Date()
  );
}

/**
 * 가맹점 추출 휴리스틱.
 * 국내 카드 문자는 가맹점명이 마지막에 오는 경우가 많다.
 * 숫자/키워드/발급사명을 걷어내고 남은 덩어리 중 마지막 것을 고른다.
 * 정확도가 높지 않으므로 Layer 2가 붙으면 이 경로는 거의 안 쓰인다.
 */
function extractMerchant_(text) {
  const noise = [
    '승인', '취소', '결제', '일시불', '개월', '누적', '잔액', '출금', '입금', '지급',
    '사용금액', '사용', '체크', '신용', '현대카드', '우리은행', '고객님', '원',
  ];
  const chunks = String(text)
    .split(/[\n\r\[\]()]+/)
    .join(' ')
    .split(/\s+/)
    .map(function (t) { return t.replace(/[,.*]+$/, '').trim(); })
    .filter(function (t) {
      if (t.length < 2) return false;
      if (/^\d/.test(t)) return false;                     // 금액·날짜 토큰
      if (/^\d{1,2}[:\/.]\d/.test(t)) return false;
      if (noise.indexOf(t) >= 0) return false;
      if (!/[가-힣A-Za-z]/.test(t)) return false;
      return true;
    });
  if (!chunks.length) return null;
  return chunks[chunks.length - 1];
}

function hasAny_(text, words) {
  for (let i = 0; i < words.length; i++) {
    if (text.indexOf(words[i]) >= 0) return true;
  }
  return false;
}

// ===== Classify.gs                                                 =====

/**
 * 분류기. 위에서 걸리면 멈춘다.
 *
 *   1. Merchant.alwaysAsk       -> 물어봄
 *   2. Merchant.isPassthrough   -> 위치로 시도, 안 되면 물어봄 (네이버페이 등)
 *   3. Merchant.defaultCategory -> 확정
 *   4. Rule (learned)           -> 확정
 *   5. Rule (builtin, contains) -> 확정
 *   6. 위치 매칭                -> 확정
 *   7. 실패                     -> 미분류. 알림으로 물어본다.
 *
 * 간편결제는 가맹점이 "네이버파이낸셜"로 뭉개져 이름으로는 손을 쓸 수 없다.
 * 좌표는 뭉개지지 않으므로 6번이 그 구멍을 메운다.
 */

function classify_(merchantRaw, amount, location) {
  const normalized = normalizeMerchant_(merchantRaw);
  const nearby = nearbyCategory_(location);

  if (!normalized) {
    return nearby.confident
      ? { categoryId: nearby.categoryId, reason: 'location', nearby: nearby }
      : { categoryId: null, reason: 'no-merchant', nearby: nearby };
  }

  const merchant = findBy_('Merchant', 'normalizedName', normalized);
  if (merchant) {
    if (merchant.alwaysAsk === true || merchant.alwaysAsk === 'TRUE') {
      return { categoryId: null, reason: 'always-ask', merchantId: merchant.id, nearby: nearby };
    }
    if (merchant.isPassthrough === true || merchant.isPassthrough === 'TRUE') {
      // 간편결제. 이름은 못 믿지만 좌표가 확실하면 그걸 쓴다.
      return nearby.confident
        ? { categoryId: nearby.categoryId, reason: 'passthrough-location',
            merchantId: merchant.id, nearby: nearby }
        : { categoryId: null, reason: 'passthrough', merchantId: merchant.id, nearby: nearby };
    }
    if (merchant.defaultCategoryId) {
      return { categoryId: merchant.defaultCategoryId, reason: 'merchant-default',
               merchantId: merchant.id, nearby: nearby };
    }
  }

  const rules = readAll_('Rule').sort(function (a, b) {
    // learned 규칙을 builtin보다 먼저 본다.
    const w = function (r) { return (r.source === 'learned' ? 0 : 1000) + (Number(r.priority) || 0); };
    return w(a) - w(b);
  });

  for (let i = 0; i < rules.length; i++) {
    if (matchRule_(rules[i], normalized, merchantRaw, amount)) {
      update_('Rule', rules[i].id, {
        hitCount: (Number(rules[i].hitCount) || 0) + 1,
        lastUsedAt: nowIso_(),
      });
      return { categoryId: rules[i].categoryId, reason: 'rule:' + rules[i].id,
               merchantId: merchant ? merchant.id : null, nearby: nearby };
    }
  }

  if (nearby.confident) {
    return { categoryId: nearby.categoryId, reason: 'location',
             merchantId: merchant ? merchant.id : null, nearby: nearby };
  }

  return { categoryId: null, reason: 'no-match',
           merchantId: merchant ? merchant.id : null, nearby: nearby };
}

// ------------------------------------------------------------- 위치 학습

const LOCATION_RADIUS_M = 60;      // 같은 자리로 볼 반경
const LOCATION_MIN_SAMPLES = 3;    // 이만큼 쌓여야 자동 확정
const LOCATION_MIN_SHARE = 0.7;    // 그 중 이 비율 이상이 같은 카테고리여야 한다

/**
 * 과거에 같은 자리에서 뭘로 분류했는지 본다.
 * 표본이 적거나 카테고리가 갈리면 confident=false로 두고 제안만 한다.
 */
function nearbyCategory_(location) {
  const empty = { categoryId: null, confident: false, samples: 0, share: 0 };
  if (!location || location.lat === null || location.lat === undefined) return empty;
  if (!location.lon && location.lon !== 0) return empty;

  const counts = {};
  let total = 0;
  readAll_('Transaction').forEach(function (t) {
    if (!t.categoryId || t.type !== 'expense') return;
    if (t.lat === '' || t.lat === null || t.lat === undefined) return;
    const distance = haversineMeters_(Number(location.lat), Number(location.lon),
                                      Number(t.lat), Number(t.lon));
    if (distance > LOCATION_RADIUS_M) return;
    counts[t.categoryId] = (counts[t.categoryId] || 0) + 1;
    total++;
  });
  if (!total) return empty;

  let bestId = null;
  let bestCount = 0;
  Object.keys(counts).forEach(function (id) {
    if (counts[id] > bestCount) { bestCount = counts[id]; bestId = id; }
  });

  const share = bestCount / total;
  return {
    categoryId: bestId,
    samples: total,
    share: Math.round(share * 100) / 100,
    confident: total >= LOCATION_MIN_SAMPLES && share >= LOCATION_MIN_SHARE,
  };
}

/** 두 좌표 사이 거리(m). */
function haversineMeters_(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = function (d) { return d * Math.PI / 180; };
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function matchRule_(rule, normalized, raw, amount) {
  const pattern = String(rule.pattern || '');
  if (!pattern) return false;
  switch (rule.matchType) {
    case 'exactMerchant':
      return normalized === normalizeMerchant_(pattern);
    case 'contains':
      return String(raw || '').indexOf(pattern) >= 0 || normalized.indexOf(pattern) >= 0;
    case 'regex':
      try { return new RegExp(pattern).test(String(raw || '')); } catch (e) { return false; }
    case 'amountRange': {
      const parts = pattern.split('-');
      const lo = parseAmount_(parts[0]);
      const hi = parseAmount_(parts[1]);
      return amount !== null && amount >= lo && amount <= hi;
    }
    default:
      return false;
  }
}

/** "(주)스타벅스코리아 역삼점1234" -> "스타벅스코리아역삼점" */
function normalizeMerchant_(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/\(주\)|\(유\)|㈜|주식회사/g, '')
    .replace(/\d+$/g, '')
    .replace(/[\s\-_.,*]/g, '')
    .trim();
}

/**
 * 사용자가 미분류 건을 고쳐줄 때 호출한다.
 * 같은 가맹점을 두 번 연속 같은 카테고리로 고르면 기본 카테고리로 승격한다.
 * (한 번 잘못 고른 것이 영구 고착되는 걸 막으려고 2회로 둔다)
 */
function learn_(merchantRaw, categoryId) {
  const normalized = normalizeMerchant_(merchantRaw);
  if (!normalized) return;

  let merchant = findBy_('Merchant', 'normalizedName', normalized);
  if (!merchant) {
    merchant = {
      id: newId_('mch'), normalizedName: normalized, displayName: merchantRaw,
      defaultCategoryId: '', isPassthrough: false, alwaysAsk: false,
      aliases: '', hitCount: 0,
    };
    append_('Merchant', merchant);
  }

  const seen = readAll_('Transaction').filter(function (t) {
    return normalizeMerchant_(t.merchantRaw) === normalized && t.categoryId === categoryId;
  });

  if (seen.length >= 1 && !merchant.defaultCategoryId) {
    // 이번 교정까지 두 번째 -> 승격
    update_('Merchant', merchant.id, { defaultCategoryId: categoryId });
  }
  update_('Merchant', merchant.id, { hitCount: (Number(merchant.hitCount) || 0) + 1 });
}

// ===== Settlement.gs                                               =====

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

// ===== Ingest.gs                                                   =====

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
  const accountId = accountFor_(parsed.issuer);
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
      txn.counterAccountId = 'acc_hyundai';
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

function isCardBill_(merchantRaw) {
  return /현대\s*카드|카드\s*대금|일시불대금/.test(String(merchantRaw || ''));
}

function isAtm_(merchantRaw) {
  return /ATM|CD기|현금인출/i.test(String(merchantRaw || ''));
}

function accountFor_(issuer) {
  if (issuer === '현대카드') return 'acc_hyundai';
  if (issuer === '우리은행') return 'acc_woori';
  return '';
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
      accountId: accountFor_(parsed.issuer), kind: 'balance',
      reported: parsed.balance, computed: '', diff: '',
      status: 'pending', rawMessageId: rawId,
    });
  }
  if (parsed.cumulative !== null && parsed.cumulative !== undefined) {
    append_('Anchor', {
      id: newId_('anc'), at: toIso_(parsed.occurredAt),
      accountId: accountFor_(parsed.issuer), kind: 'cumulative',
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
  let fixed = 0;
  rows.forEach(function (r) {
    const parsed = parseMessage_(r.body, r.sender, new Date(r.receivedAt));
    update_('RawMessage', r.id, {
      parserVersion: CONFIG.parserVersion,
      parsedOk: parsed.ok,
      parseNote: parsed.note,
    });
    if (parsed.ok) fixed++;
  });
  return { scanned: rows.length, nowParsed: fixed };
}

// ===== Code.gs                                                     =====

/**
 * 웹앱 진입점.
 *
 *   POST  {action:"ingest",     token, body, sender, receivedAt, lat, lon, placeName}
 *   POST  {action:"categorize", token, txnId, categoryId}
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
