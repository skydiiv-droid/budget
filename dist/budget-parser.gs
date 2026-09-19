/**
 * 이 파일은 build.js가 생성합니다. 직접 고치지 마세요.
 * 원본: apps-script/Parse.gs
 *
 * 사용법: 전체를 복사해 Apps Script의 같은 이름 파일에 붙여넣으세요.
 */
// ===== Parse.gs ==================================================

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
  const haystack = String(sender || '') + '\n' + text;
  if (/현대\s*카드/.test(haystack)) return '현대카드';
  // 실제 우리은행 문자는 "[Web발신]\n우리 09/19 14:16" 처럼 은행명이 "우리" 한 단어다.
  // "[우리]" 나 "우리은행" 만 찾으면 놓친다.
  if (/우리은행|\[우리\]|(^|\n)\s*우리[\s\d]/.test(haystack)) return '우리은행';
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
    // 마스킹된 계좌번호(*478794)는 금액이 아니다
    if (text.charAt(m.index - 1) === '*') continue;
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
