/**
 * 이 파일은 build.js가 생성합니다. 직접 고치지 마세요.
 * 원본: apps-script/Config.gs, apps-script/Util.gs, apps-script/Schema.gs, apps-script/Seed.gs, apps-script/Classify.gs, apps-script/Menu.gs, apps-script/Settlement.gs, apps-script/Ingest.gs, apps-script/Code.gs, apps-script/Debug.gs
 *
 * 사용법: 전체를 복사해 Apps Script의 같은 이름 파일에 붙여넣으세요.
 */
// ===== Config.gs =================================================

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
  parserVersion: 2,

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

// ===== Util.gs ===================================================

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

// ===== Schema.gs =================================================

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
  seedRules_();
  seedMerchants_();
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

// ===== Seed.gs ===================================================

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

// 카드는 장마다 한 줄. 월 누적 사용금액이 카드별로 따로 오므로
// 한 계정으로 합치면 누적 앵커가 서로 덮어써 대사가 깨진다.
const SEED_ACCOUNTS = [
  // [id, 이름, 종류, 발급사, 뒷자리, 마감일, 결제일]
  ['acc_woori',    '우리은행',          'checking', '우리은행', '', '', ''],
  ['acc_hd_emart', '현대 이마트Plus',   'card',     '현대카드', '', '', 5],
  ['acc_hd_mirae', '현대 미래에셋',     'card',     '현대카드', '', '', 5],
  ['acc_cash',     '현금',              'cash',     '',         '', '', ''],
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

/**
 * 기본 분류 규칙.
 *
 * priority가 작을수록 먼저 본다. 포함 검사라서 좁은 것을 먼저 둬야 한다
 * ("이마트24"가 "이마트"에 먼저 걸리면 편의점이 마트로 분류된다).
 *
 * 여기 없는 곳은 처음 한 번 물어보고, 같은 답이 두 번 나오면 스스로 외운다.
 */
const SEED_RULES = [
  // [우선순위, 패턴, 카테고리]
  [10, '이마트24',     'cat_convenience'],   // "이마트"보다 먼저
  [10, 'GS25',         'cat_convenience'],
  [10, '쿠팡이츠',     'cat_delivery'],      // "쿠팡"보다 먼저
  [10, '쿠팡플레이',   'cat_sub_media'],

  [20, 'CU',           'cat_convenience'],
  [20, '세븐일레븐',   'cat_convenience'],
  [20, '미니스톱',     'cat_convenience'],

  [20, '이마트',       'cat_grocery'],
  [20, '홈플러스',     'cat_grocery'],
  [20, '롯데마트',     'cat_grocery'],
  [20, '하나로마트',   'cat_grocery'],
  [20, '코스트코',     'cat_grocery'],

  [20, '스타벅스',     'cat_cafe'],
  [20, '컴포즈',       'cat_cafe'],
  [20, '메가커피',     'cat_cafe'],
  [20, '메가엠지씨',   'cat_cafe'],
  [20, '투썸',         'cat_cafe'],
  [20, '이디야',       'cat_cafe'],
  [20, '빽다방',       'cat_cafe'],
  [20, '할리스',       'cat_cafe'],
  [20, '파스쿠찌',     'cat_cafe'],
  [20, '공차',         'cat_cafe'],

  [20, '배달의민족',   'cat_delivery'],
  [20, '배민',         'cat_delivery'],
  [20, '요기요',       'cat_delivery'],

  [20, '티머니',       'cat_transport'],
  [20, '카카오티',     'cat_transport'],
  [20, '카카오T',      'cat_transport'],
  [20, '코레일',       'cat_transport'],
  [20, 'SRT',          'cat_transport'],
  [20, '고속버스',     'cat_transport'],
  [20, '주차',         'cat_transport'],

  [20, '올리브영',     'cat_beauty'],

  [20, '쿠팡',         'cat_shopping'],
  [20, '무신사',       'cat_shopping'],
  [20, '11번가',       'cat_shopping'],
  [20, '지마켓',       'cat_shopping'],
  [20, '옥션',         'cat_shopping'],
  [20, '알리익스프레스','cat_shopping'],
  [20, '다이소',       'cat_shopping'],

  // 매달 빠져나가는 것들. 고정지출 화면이 이 둘을 본다.
  [20, 'APPLE',        'cat_sub_digital'],
  [20, '애플',         'cat_sub_digital'],
  [20, 'ICLOUD',       'cat_sub_digital'],
  [20, 'GOOGLE',       'cat_sub_digital'],
  [20, '구글',         'cat_sub_digital'],
  [20, 'ANTHROPIC',    'cat_sub_digital'],
  [20, 'CLAUDE',       'cat_sub_digital'],
  [20, 'OPENAI',       'cat_sub_digital'],
  [20, 'NETFLIX',      'cat_sub_media'],
  [20, '넷플릭스',     'cat_sub_media'],
  [20, '티빙',         'cat_sub_media'],
  [20, '웨이브',       'cat_sub_media'],
  [20, '왓챠',         'cat_sub_media'],
  [20, 'YOUTUBE',      'cat_sub_media'],
  [20, '유튜브',       'cat_sub_media'],
  [20, '멜론',         'cat_sub_media'],
  [20, 'SPOTIFY',      'cat_sub_media'],

  [20, 'SKT',          'cat_telecom'],
  [20, 'KT',           'cat_telecom'],
  [20, 'LGU',          'cat_telecom'],
  [20, '유플러스',     'cat_telecom'],

  // 넓은 낱말은 마지막에 본다
  [100, '커피',        'cat_cafe'],
  [100, '카페',        'cat_cafe'],
  [100, '약국',        'cat_medical'],
  [100, '병원',        'cat_medical'],
  [100, '의원',        'cat_medical'],
  [100, '치과',        'cat_medical'],
  [100, '한의원',      'cat_medical'],
  [100, '미용실',      'cat_beauty'],
  [100, '헤어',        'cat_beauty'],
  [100, '네일',        'cat_beauty'],
  [100, '택시',        'cat_transport'],
  [100, '연회비',      'cat_finance'],
  [100, '수수료',      'cat_finance'],
];

/**
 * 간편결제 대행사.
 * 가맹점명이 "네이버파이낸셜"로 뭉개져 무엇을 샀는지 알 수 없으므로
 * 이름으로는 분류하지 않고 좌표나 사용자에게 맡긴다.
 */
const SEED_PASSTHROUGH = [
  '네이버파이낸셜', '네이버페이', '카카오페이', '토스페이먼츠', '페이코', 'NHN페이코',
];

function seedRules_() {
  if (readAll_('Rule').length) return;
  SEED_RULES.forEach(function (row) {
    append_('Rule', {
      id: newId_('rul'), priority: row[0], matchType: 'contains',
      pattern: row[1], categoryId: row[2], source: 'builtin',
      hitCount: 0, lastUsedAt: '',
    });
  });
}

function seedMerchants_() {
  if (readAll_('Merchant').length) return;
  SEED_PASSTHROUGH.forEach(function (name) {
    append_('Merchant', {
      id: newId_('mch'), normalizedName: normalizeMerchant_(name), displayName: name,
      defaultCategoryId: '', isPassthrough: true, alwaysAsk: false,
      aliases: '', hitCount: 0,
    });
  });
}

/**
 * 빠진 시드만 채운다.
 *
 * setup() 의 시드 함수들은 시트가 비어 있을 때만 넣는다 — 사용자가 일부러
 * 지운 항목을 되살리지 않기 위해서다. 그래서 이미 쓰던 시트에 새 카테고리나
 * 새 기본 규칙이 추가되면 들어가지 않는다. 그때 이걸 실행한다.
 *
 * 있는 것은 건드리지 않고 없는 것만 더한다. 여러 번 실행해도 안전하다.
 */
function resync() {
  const added = { categories: 0, accounts: 0, rules: 0, merchants: 0 };

  const haveCategory = {};
  readAll_('Category').forEach(function (c) { haveCategory[c.id] = true; });
  SEED_CATEGORIES.forEach(function (row, i) {
    if (haveCategory[row[0]]) return;
    append_('Category', {
      id: row[0], name: row[1], parentId: row[2],
      kind: row[3], icon: row[4], sortOrder: i,
    });
    added.categories++;
  });

  // 직접 만든 규칙(learned)은 세지 않는다. 기본 규칙만 채운다.
  const haveRule = {};
  readAll_('Rule').forEach(function (r) {
    if (r.source === 'builtin') haveRule[String(r.pattern)] = true;
  });
  SEED_RULES.forEach(function (row) {
    if (haveRule[row[1]]) return;
    append_('Rule', {
      id: newId_('rul'), priority: row[0], matchType: 'contains',
      pattern: row[1], categoryId: row[2], source: 'builtin',
      hitCount: 0, lastUsedAt: '',
    });
    added.rules++;
  });

  const haveAccount = {};
  readAll_('Account').forEach(function (a) { haveAccount[a.id] = true; });
  SEED_ACCOUNTS.forEach(function (row) {
    if (haveAccount[row[0]]) return;
    append_('Account', {
      id: row[0], name: row[1], type: row[2], issuer: row[3],
      last4: row[4], closingDay: row[5], billingDay: row[6], active: true,
    });
    added.accounts++;
  });

  const haveMerchant = {};
  readAll_('Merchant').forEach(function (m) { haveMerchant[m.normalizedName] = true; });
  SEED_PASSTHROUGH.forEach(function (name) {
    const normalized = normalizeMerchant_(name);
    if (haveMerchant[normalized]) return;
    append_('Merchant', {
      id: newId_('mch'), normalizedName: normalized, displayName: name,
      defaultCategoryId: '', isPassthrough: true, alwaysAsk: false,
      aliases: '', hitCount: 0,
    });
    added.merchants++;
  });

  Logger.log('카테고리 ' + added.categories + '개 · 계정 ' + added.accounts +
             '개 · 기본 규칙 ' + added.rules + '개 · 간편결제 ' + added.merchants +
             '개를 더했습니다.');
  return added;
}

// ===== Classify.gs ===============================================

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
 * 가맹점명에서 브랜드로 쓸 만한 낱말을 골라 준다.
 *
 * "컴포즈커피발산" 을 카페로 정했을 때, 다음에 "컴포즈커피강남" 이 오면
 * 또 물어보는 게 맞을까? 프랜차이즈는 지점명이 붙어 이름이 매번 달라진다.
 * 그래서 규칙을 걸 범위를 정할 수 있어야 하고, 그 후보를 여기서 뽑는다.
 *
 * 짚이는 게 없으면 조용히 "이 이름 그대로"를 권한다. 억지로 낱말을 잘라내면
 * 엉뚱한 곳까지 같이 분류돼 버린다.
 */
function suggestKeyword_(merchantRaw) {
  const normalized = normalizeMerchant_(merchantRaw);
  if (!normalized) return { scope: 'exact', keyword: '', reason: 'no-merchant' };

  // 1. 이미 아는 브랜드가 이름 안에 들어 있으면 그것을 쓴다
  //    "컴포즈커피발산" 안의 "컴포즈"
  const known = readAll_('Rule')
    .filter(function (r) { return r.matchType === 'contains' && r.pattern; })
    .map(function (r) { return String(r.pattern); })
    .filter(function (pattern) {
      return pattern.length >= 2 && normalized.indexOf(pattern) >= 0;
    })
    .sort(function (a, b) { return b.length - a.length; });   // 긴 쪽이 더 구체적이다
  if (known.length) {
    return { scope: 'contains', keyword: known[0], reason: 'known-brand' };
  }

  // 2. 과거에 다녀온 곳들과 앞부분이 겹치면 그 부분이 브랜드다
  //    "컴포즈커피발산" 과 "컴포즈커피강남" -> "컴포즈커피"
  const prefix = sharedPrefix_(normalized);
  if (prefix.length >= 3) {
    return { scope: 'contains', keyword: prefix, reason: 'shared-prefix' };
  }

  return { scope: 'exact', keyword: normalized, reason: 'no-clue' };
}

/** 과거 가맹점들과 겹치는 가장 긴 앞부분. 같은 이름은 세지 않는다. */
function sharedPrefix_(normalized) {
  let best = '';
  readAll_('Transaction').forEach(function (t) {
    const other = normalizeMerchant_(t.merchantRaw);
    if (!other || other === normalized) return;
    let i = 0;
    while (i < other.length && i < normalized.length && other.charAt(i) === normalized.charAt(i)) i++;
    if (i > best.length) best = normalized.slice(0, i);
  });
  return best;
}

/**
 * 사용자가 미분류 건을 고쳐줄 때 호출한다.
 *
 *   scope 'once'     이 건만. 규칙을 만들지 않는다
 *   scope 'exact'    이 가맹점명과 똑같은 것만
 *   scope 'contains' keyword 가 들어간 모든 가맹점
 *
 * 같은 범위의 규칙이 이미 있으면 새로 만들지 않고 카테고리만 바꾼다.
 * 생각이 바뀌어 다시 고를 때 규칙이 쌓이면 안 된다.
 */
function learn_(merchantRaw, categoryId, scope, keyword) {
  const normalized = normalizeMerchant_(merchantRaw);
  if (!normalized || !categoryId) return { scope: 'once', reason: 'nothing-to-learn' };
  if (scope === 'once') return { scope: 'once' };

  const merchant = ensureMerchant_(normalized, merchantRaw);

  if (scope === 'contains') {
    const pattern = String(keyword || '').trim();
    if (pattern.length < 2) return { scope: 'once', reason: 'keyword-too-short' };

    const existing = readAll_('Rule').filter(function (r) {
      return r.matchType === 'contains' && String(r.pattern) === pattern && r.source === 'learned';
    })[0];

    if (existing) {
      update_('Rule', existing.id, { categoryId: categoryId });
      return { scope: 'contains', keyword: pattern, ruleId: existing.id, updated: true };
    }

    const rule = {
      id: newId_('rul'),
      priority: 10,          // 직접 정한 것이니 기본 규칙보다 먼저 본다
      matchType: 'contains',
      pattern: pattern,
      categoryId: categoryId,
      source: 'learned',
      hitCount: 0,
      lastUsedAt: '',
    };
    append_('Rule', rule);
    return { scope: 'contains', keyword: pattern, ruleId: rule.id };
  }

  // exact — 가맹점 자체에 기본 카테고리를 단다. 규칙 표를 늘리지 않는다.
  update_('Merchant', merchant.id, { defaultCategoryId: categoryId });
  return { scope: 'exact', keyword: normalized, merchantId: merchant.id };
}

function ensureMerchant_(normalized, displayName) {
  const found = findBy_('Merchant', 'normalizedName', normalized);
  if (found) {
    update_('Merchant', found.id, { hitCount: (Number(found.hitCount) || 0) + 1 });
    return found;
  }
  const merchant = {
    id: newId_('mch'), normalizedName: normalized, displayName: displayName || normalized,
    defaultCategoryId: '', isPassthrough: false, alwaysAsk: false,
    aliases: '', hitCount: 1,
  };
  append_('Merchant', merchant);
  return merchant;
}

/**
 * 새로 만든 규칙을 아직 분류되지 않은 과거 거래에도 적용한다.
 * 규칙 하나를 정하면 밀려 있던 같은 가게 건들이 한꺼번에 정리된다.
 * 이미 분류된 건은 건드리지 않는다 — 사용자가 일부러 다르게 넣었을 수 있다.
 */
function applyToPending_(categoryId, scope, keyword) {
  if (scope === 'once' || !keyword) return 0;
  let count = 0;

  readAll_('Transaction').forEach(function (t) {
    if (t.status !== 'pendingCategory' || t.categoryId) return;
    const normalized = normalizeMerchant_(t.merchantRaw);
    if (!normalized) return;

    const hit = scope === 'contains'
      ? normalized.indexOf(keyword) >= 0
      : normalized === keyword;
    if (!hit) return;

    update_('Transaction', t.id, { categoryId: categoryId, status: 'confirmed' });
    count++;
  });
  return count;
}

/** 지금 걸려 있는 분류 규칙을 한눈에 본다. */
function listRules() {
  const categoryName = function (id) {
    const c = findBy_('Category', 'id', id);
    return c ? c.name : id;
  };

  const fromMerchants = readAll_('Merchant')
    .filter(function (m) { return m.defaultCategoryId; })
    .map(function (m) {
      return { 범위: '이름이 같으면', 패턴: m.normalizedName,
               카테고리: categoryName(m.defaultCategoryId), 출처: '직접' };
    });

  const fromRules = readAll_('Rule').map(function (r) {
    return {
      범위: r.matchType === 'contains' ? '포함하면' : '이름이 같으면',
      패턴: r.pattern,
      카테고리: categoryName(r.categoryId),
      출처: r.source === 'learned' ? '직접' : '기본',
      쓰인횟수: Number(r.hitCount) || 0,
    };
  });

  const all = fromMerchants.concat(fromRules);
  all.forEach(function (row) {
    Logger.log([row.출처, row.범위, row.패턴, '->', row.카테고리,
                row.쓰인횟수 === undefined ? '' : '(' + row.쓰인횟수 + '회)'].join(' '));
  });
  Logger.log('규칙 ' + all.length + '개');
  return all;
}

/** 잘못 만든 규칙을 지운다. 패턴 문자열로 지목한다. */
function forgetRule(payload) {
  const pattern = String((payload && payload.pattern) || '').trim();
  if (!pattern) return { status: 'error', reason: 'need-pattern' };

  let removed = 0;

  const sheet = sheet_('Rule');
  const headers = SCHEMA.Rule;
  const values = sheet.getDataRange().getValues();
  const patternCol = headers.indexOf('pattern');
  const sourceCol = headers.indexOf('source');
  // 뒤에서부터 지워야 행 번호가 밀리지 않는다
  for (let r = values.length - 1; r >= 1; r--) {
    if (String(values[r][patternCol]) !== pattern) continue;
    if (values[r][sourceCol] !== 'learned') continue;   // 기본 규칙은 남긴다
    sheet.deleteRow(r + 1);
    removed++;
  }

  const merchant = findBy_('Merchant', 'normalizedName', normalizeMerchant_(pattern));
  if (merchant && merchant.defaultCategoryId) {
    update_('Merchant', merchant.id, { defaultCategoryId: '' });
    removed++;
  }

  Logger.log(removed ? ('규칙 ' + removed + '개를 지웠습니다: ' + pattern)
                     : ('지울 규칙이 없습니다: ' + pattern));
  return { status: 'ok', removed: removed };
}

// ===== Menu.gs ===================================================

/**
 * 아이폰 단축어에 그대로 띄울 메뉴를 서버가 만들어 준다.
 *
 * 단축어에서 JSON 배열을 다루는 건 번거롭다. 사전에서 값 꺼내고, 반복하고,
 * id를 따로 들고 다녀야 한다. 그래서 여기서 **줄바꿈으로 이어붙인 글자**를
 * 만들어 보낸다. 단축어는 이렇게만 하면 된다.
 *
 *   텍스트 나누기(줄바꿈) -> 목록에서 선택 -> 고른 글자를 그대로 되돌려주기
 *
 * 되돌아온 글자는 서버가 알아서 해석한다. 단축어는 id를 몰라도 된다.
 */

/** 카테고리 메뉴. 짚이는 것 몇 개를 앞에 둔다. */
function categoryMenuText_(decision) {
  const categories = readAll_('Category').filter(function (c) { return c.kind === 'expense'; });
  const suggested = suggestionsFor_(decision).map(function (c) { return c.id; });

  const order = function (c) {
    const rank = suggested.indexOf(c.id);
    return rank >= 0 ? rank : 100 + (Number(c.sortOrder) || 0);
  };

  return categories
    .sort(function (a, b) { return order(a) - order(b); })
    .map(function (c) { return (c.icon ? c.icon + ' ' : '') + c.name; })
    .join('\n');
}

/**
 * 규칙 범위 메뉴.
 *
 *   모두: 컴포즈            -> 그 낱말이 들어간 모든 가맹점
 *   이 가게만: 컴포즈커피발산 -> 이름이 똑같은 곳만
 *   이번만                  -> 규칙을 만들지 않음
 *
 * 앞머리로 구분하므로 되돌아온 글자를 그대로 해석할 수 있다.
 */
function scopeMenuText_(merchantRaw) {
  const hint = suggestKeyword_(merchantRaw);
  const normalized = normalizeMerchant_(merchantRaw);
  const lines = [];

  if (hint.scope === 'contains' && hint.keyword && hint.keyword !== normalized) {
    lines.push('모두: ' + hint.keyword);
  }
  if (normalized) lines.push('이 가게만: ' + normalized);
  lines.push('이번만');
  return lines.join('\n');
}

/** 메뉴에서 고른 글자를 카테고리로 되돌린다. "☕ 카페" -> cat_cafe */
function resolveCategory_(choice) {
  const text = String(choice || '').trim();
  if (!text) return null;

  const categories = readAll_('Category');

  const byId = categories.filter(function (c) { return c.id === text; })[0];
  if (byId) return byId.id;

  // 아이콘이 앞에 붙어 오므로 이름이 들어 있는지로 찾는다.
  // 짧은 이름이 긴 이름에 걸리지 않게 긴 쪽부터 본다 ("구독" vs "구독디지털").
  const matched = categories
    .filter(function (c) { return c.name && text.indexOf(c.name) >= 0; })
    .sort(function (a, b) { return b.name.length - a.name.length; })[0];

  return matched ? matched.id : null;
}

/** 범위 메뉴에서 고른 글자를 해석한다. */
function parseScopeChoice_(choice, merchantRaw) {
  const text = String(choice || '').trim();

  if (text.indexOf('모두:') === 0) {
    return { scope: 'contains', keyword: text.slice(3).trim() };
  }
  if (text.indexOf('이 가게만') === 0) {
    return { scope: 'exact', keyword: normalizeMerchant_(merchantRaw) };
  }
  if (text.indexOf('이번만') === 0) {
    return { scope: 'once', keyword: '' };
  }

  // 아무것도 안 고르고 넘어오면 서버가 권하는 범위를 쓴다
  const hint = suggestKeyword_(merchantRaw);
  return { scope: hint.scope, keyword: hint.keyword };
}

/** 알림에 그대로 띄울 한 줄. */
function confirmMessage_(categoryId, learned, alsoFixed) {
  const category = findBy_('Category', 'id', categoryId);
  const name = category ? category.name : categoryId;
  const parts = [name + '(으)로 저장'];

  if (learned.scope === 'contains' && learned.keyword) {
    parts.push('앞으로 「' + learned.keyword + '」는 자동');
  } else if (learned.scope === 'exact' && learned.keyword) {
    parts.push('앞으로 이 가게는 자동');
  }
  if (alsoFixed) parts.push('밀려 있던 ' + alsoFixed + '건도 정리');

  return parts.join(' · ');
}

// ===== Settlement.gs =============================================

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

// ===== Ingest.gs =================================================

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

// ===== Code.gs ===================================================

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

// ===== Debug.gs ==================================================

/**
 * 편집기에서 직접 돌려보는 점검 함수들.
 * 단축어가 문제인지 서버가 문제인지 가르는 데 쓴다.
 */

/**
 * 가짜 문자 한 건을 넣어 파이프라인이 도는지 본다.
 * 단축어 없이 서버만 시험하므로, 여기서 성공하면 남은 문제는 아이폰 쪽이다.
 *
 * 편집기 함수 목록에서 selfTest 를 골라 실행하고 로그를 본다.
 */
function selfTest() {
  const sample = [
    '[Web발신]',
    '우리 09/19 14:16',
    '*123456',
    '입금 10,000원',
    '홍길동',
    '잔액 500,000원',
  ].join('\n');

  const before = readAll_('RawMessage').length;
  const result = ingest({ body: sample, sender: 'selfTest', receivedAt: new Date().toISOString() });
  const after = readAll_('RawMessage').length;

  Logger.log('결과: ' + JSON.stringify(result, null, 2));
  Logger.log('RawMessage: ' + before + '건 -> ' + after + '건');

  if (after > before) {
    Logger.log('서버는 정상입니다. 수집이 안 된다면 아이폰 단축어 쪽을 보세요.');
  } else if (result.status === 'duplicate') {
    Logger.log('같은 문자가 이미 있습니다. 한 번 더 실행하면 시각이 달라져 들어갑니다.');
  } else {
    Logger.log('서버에서 막혔습니다: ' + result.status + ' / ' + (result.reason || ''));
  }
  return result;
}

/** 설정이 빠진 곳이 있는지 훑는다. */
function checkSetup() {
  const problems = [];

  try {
    getIngestToken_();
  } catch (e) {
    problems.push('스크립트 속성 INGEST_TOKEN 이 없습니다. 프로젝트 설정에서 추가하세요.');
  }

  Object.keys(SCHEMA).forEach(function (name) {
    if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name)) {
      problems.push('시트 없음: ' + name + ' — setup() 을 실행하세요.');
    }
  });

  if (!readAll_('Category').length) {
    problems.push('카테고리가 비어 있습니다 — setup() 을 실행하세요.');
  }

  if (problems.length) {
    problems.forEach(function (p) { Logger.log('✗ ' + p); });
  } else {
    Logger.log('✓ 설정에 빠진 곳이 없습니다.');
    Logger.log('  파서 버전 ' + CONFIG.parserVersion +
               ' · 문자 ' + readAll_('RawMessage').length + '건' +
               ' · 거래 ' + readAll_('Transaction').length + '건');
  }
  return problems;
}
