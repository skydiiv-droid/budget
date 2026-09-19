/**
 * 문자 파서 — 3계층.
 *
 *   Layer 1  제네릭 추출기 : 샘플이 하나도 없어도 동작하는 휴리스틱
 *   Layer 2  패턴 테이블   : 실제 문자 포맷에 맞춘 정규식. 있으면 우선
 *   Layer 3  교정 학습     : 사람이 고친 결과로 패턴 후보를 만든다 (아직)
 *
 * 어느 계층도 못 읽으면 실패로 두고 원문만 남긴다.
 * 파싱 실패는 에러가 아니라 정상 상태다 — 인박스에서 사람이 처리한다.
 *
 * 이 파일은 플랫폼을 타지 않는다. 함수에서도 브라우저에서도 그대로 돈다.
 */

const KEYWORDS = {
  cancel: ['취소'],
  approval: ['승인', '결제'],
  withdrawal: ['출금', '지급'],
  deposit: ['입금'],
  ad: ['(광고)', '[광고]', '광고)'],
};

/** 금액 앞에 붙는 라벨 -> 역할. 앞쪽(최대 8자)을 훑어 판정한다. */
const AMOUNT_LABELS = [
  { role: 'balance', words: ['잔액'] },
  { role: 'cumulative', words: ['누적'] },
  { role: 'amount', words: ['승인', '결제', '출금', '입금', '지급', '사용'] },
];

const MERCHANT_NOISE = [
  '승인', '취소', '결제', '일시불', '개월', '누적', '잔액', '출금', '입금', '지급',
  '사용금액', '사용', '체크', '신용', '현대카드', '우리은행', '현대', '우리',
  '고객님', '원', 'Web발신',
];

export function parseMessage(body, sender, receivedAt, patterns = []) {
  const text = String(body || '').trim();
  const now = receivedAt instanceof Date ? receivedAt : new Date(receivedAt || Date.now());

  const result = {
    ok: false,
    note: '',
    issuer: detectIssuer(text, sender),
    cardName: detectCardName(text),   // 카드가 여러 장이면 이걸로 가른다
    kind: null,           // approval | cancel | withdrawal | deposit | ad | unknown
    amount: null,
    balance: null,        // 은행 잔액 앵커
    cumulative: null,     // 카드 월 누적 앵커
    occurredAt: null,
    merchantRaw: null,
    installmentMonths: 0,
    confidence: 0,
    layer: null,
  };

  if (hasAny(text, KEYWORDS.ad)) {
    return { ...result, kind: 'ad', ok: true, layer: 'keyword',
             note: '광고 문자 — 거래 생성 안 함', occurredAt: now };
  }

  const byPattern = applyPatterns(text, result.issuer, patterns);
  if (byPattern) {
    Object.assign(result, byPattern);
    result.layer = 'pattern';
    result.confidence = 1.0;
  } else {
    applyGeneric(text, result, now);
    result.layer = 'generic';
  }

  if (!result.occurredAt) result.occurredAt = now;

  result.ok = result.kind !== null && result.kind !== 'unknown' && result.amount !== null;
  if (!result.ok && !result.note) {
    result.note = result.amount === null ? '금액을 못 찾음' : '거래 종류를 못 정함';
  }
  return result;
}

// ---------------------------------------------------------------- Layer 2

/**
 * 패턴 테이블을 우선순위대로 적용한다.
 * fields 는 캡처 그룹 번호 -> 필드명 매핑.
 *   예) {"1":"month","2":"day","5":"amount","6":"merchantRaw"}
 */
export function applyPatterns(text, issuer, patterns) {
  const candidates = (patterns || [])
    .filter((p) => p.enabled !== false)
    .filter((p) => !p.issuer || p.issuer === issuer)
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0));

  for (const p of candidates) {
    let match;
    try {
      match = new RegExp(p.regex).exec(text);
    } catch {
      continue;   // 잘못 적은 정규식은 건너뛴다
    }
    if (!match) continue;

    const fields = typeof p.fields === 'string' ? JSON.parse(p.fields || '{}') : (p.fields || {});
    const parts = {};
    for (const [group, name] of Object.entries(fields)) parts[name] = match[Number(group)];

    const out = { kind: p.kind };
    if (parts.amount !== undefined) out.amount = parseAmount(parts.amount);
    if (parts.balance !== undefined) out.balance = parseAmount(parts.balance);
    if (parts.cumulative !== undefined) out.cumulative = parseAmount(parts.cumulative);
    if (parts.merchantRaw !== undefined) out.merchantRaw = String(parts.merchantRaw).trim();
    if (parts.installmentMonths !== undefined) {
      out.installmentMonths = parseAmount(parts.installmentMonths) || 0;
    }
    return out;
  }
  return null;
}

// ---------------------------------------------------------------- Layer 1

function applyGeneric(text, result, now) {
  result.kind = detectKind(text);

  for (const a of extractAmounts(text)) {
    if (a.role === 'balance' && result.balance === null) result.balance = a.value;
    else if (a.role === 'cumulative' && result.cumulative === null) result.cumulative = a.value;
    else if (a.role === 'amount' && result.amount === null) result.amount = a.value;
  }

  // 라벨이 없는 숫자만 있을 때: 잔액/누적으로 안 잡힌 첫 번째를 거래 금액으로 본다
  if (result.amount === null) {
    const unlabeled = extractAmounts(text).find((a) => a.role === 'unknown');
    if (unlabeled) result.amount = unlabeled.value;
  }

  const when = extractDateTime(text, now);
  if (when) result.occurredAt = when;

  const months = /(\d{1,2})\s*개월/.exec(text);
  if (months) result.installmentMonths = Number(months[1]);

  result.merchantRaw = extractMerchant(text);

  // 휴리스틱이라 신뢰도를 낮게 잡아 둔다. Layer 2 만 1.0 을 받는다.
  let score = 0;
  if (result.amount !== null) score += 0.5;
  if (result.kind && result.kind !== 'unknown') score += 0.2;
  if (result.merchantRaw) score += 0.2;
  if (result.occurredAt) score += 0.1;
  result.confidence = Math.round(Math.min(score, 0.9) * 100) / 100;
}

/**
 * 어느 곳에서 온 문자인지 가린다.
 *
 * 둘 다 이름을 온전히 적지 않는다.
 *   우리은행 : "우리 09/19 14:16"
 *   현대카드 : "현대 이마트Plus 승인"   <- 카드 상품명이 붙어 "현대카드"가 없다
 *
 * 은행을 먼저 본다. 카드 문자에 은행 이름이 섞이는 일은 없지만,
 * 은행 문자의 가맹점이 "현대백화점"일 수는 있기 때문이다.
 */
export function detectIssuer(text, sender) {
  const haystack = `${sender || ''}\n${text}`;

  if (/우리은행|\[우리\]|(^|\n)\s*우리[\s\d]/.test(haystack)) return '우리은행';

  const looksLikeCard = /승인|일시불|누적|할부/.test(haystack);
  if (looksLikeCard && /(^|\n)\s*현대[\s가-힣A-Za-z]/.test(haystack)) return '현대카드';
  if (/현대\s*카드/.test(haystack)) return '현대카드';

  return '';
}

/**
 * 카드 상품명. "현대 이마트Plus 승인" -> "이마트Plus"
 *
 * 카드를 여러 장 쓰면 어느 카드인지 갈라야 한다. 월 누적 사용금액이 카드마다
 * 따로 오기 때문에, 한 계정으로 합치면 누적 앵커가 서로 덮어써 대사가 깨진다.
 */
export function detectCardName(text) {
  const m = /(^|\n)\s*현대\s+([가-힣A-Za-z0-9+]+(?:\s?[가-힣A-Za-z0-9+]+)?)\s+(?:승인|취소|결제)/
    .exec(String(text || ''));
  return m ? m[2].trim() : '';
}

export function detectKind(text) {
  // 취소를 승인보다 먼저 본다 — "승인취소"에는 둘 다 들어 있다
  if (hasAny(text, KEYWORDS.cancel)) return 'cancel';
  if (hasAny(text, KEYWORDS.approval)) return 'approval';
  if (hasAny(text, KEYWORDS.deposit)) return 'deposit';
  if (hasAny(text, KEYWORDS.withdrawal)) return 'withdrawal';
  return 'unknown';
}

/**
 * 문자 안의 금액 후보를 찾는다.
 *
 * 숫자를 전부 주우면 날짜(09/19), 시각(14:16), 계좌번호(*478794)까지 딸려 온다.
 * 그래서 돈이라는 근거가 하나라도 있는 것만 남긴다.
 *
 *   "원"이 붙었다        -> 1원 같은 소액도 돈이다
 *   자릿수 쉼표가 있다    -> 은행 문자는 "원"을 생략하기도 한다
 *   네 자리 이상 + 라벨   -> "승인 5600" 처럼 둘 다 없는 경우
 */
export function extractAmounts(text) {
  const out = [];
  const re = /(\d[\d,]*\d|\d)(\s*원)?/g;
  const body = String(text || '');
  let m;

  while ((m = re.exec(body)) !== null) {
    const raw = m[1];
    // 마스킹된 계좌번호(*478794)는 금액이 아니다
    if (body.charAt(m.index - 1) === '*') continue;

    const before = body.slice(Math.max(0, m.index - 8), m.index);
    const role = roleOf(before);
    const hasWon = Boolean(m[2]);
    const hasComma = raw.includes(',');
    const longEnough = raw.replace(/,/g, '').length >= 4;

    if (!hasWon && !hasComma && !(longEnough && role !== 'unknown')) continue;

    const value = parseAmount(raw);
    if (value === null) continue;
    out.push({ value, role, index: m.index });
  }
  return out;
}

function roleOf(before) {
  for (const label of AMOUNT_LABELS) {
    if (label.words.some((w) => before.includes(w))) return label.role;
  }
  return 'unknown';
}

/**
 * 가맹점 추출 휴리스틱.
 *
 * 걷어내야 할 것이 많다.
 *   "누적3,634,067원"  금액이 붙은 덩어리. 띄어쓰기가 없어 한 토막으로 잡힌다
 *   "신*우"            가려진 본인 이름. 가맹점이 아니다
 *   "09/19" "19:14"    날짜와 시각
 */
export function extractMerchant(text) {
  const chunks = String(text || '')
    .split(/[\n\r[\]()]+/)
    .join(' ')
    .split(/\s+/)
    .map((t) => t.replace(/[,.]+$/, '').trim())
    .filter((t) => {
      if (t.length < 2) return false;
      if (MERCHANT_NOISE.includes(t)) return false;
      if (!/[가-힣A-Za-z]/.test(t)) return false;
      if (/^\d/.test(t)) return false;              // 1,800원 · 09/19
      if (/[*]/.test(t)) return false;              // 신*우 · *478794
      if (/[:/]/.test(t)) return false;             // 19:14 · 09/19
      if (/\d[\d,]*원/.test(t)) return false;       // 누적3,634,067원
      if (/\d{1,3}(?:,\d{3})+/.test(t)) return false;
      return true;
    });
  return chunks.length ? chunks[chunks.length - 1] : null;
}

/** "(주)스타벅스코리아 역삼점1234" -> "스타벅스코리아역삼점" */
export function normalizeMerchant(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/\(주\)|\(유\)|㈜|주식회사/g, '')
    .replace(/\d+$/g, '')
    .replace(/[\s\-_.,*]/g, '')
    .trim();
}

/** "1,234,567" / "1234567" -> 1234567 (원 단위 정수) */
export function parseAmount(text) {
  if (text === null || text === undefined) return null;
  const digits = String(text).replace(/[^\d-]/g, '');
  return digits ? parseInt(digits, 10) : null;
}

/** MM/DD, MM.DD, MM월DD일 + HH:MM */
function extractDateTime(text, now) {
  const date = /(\d{1,2})[/.월](\d{1,2})일?/.exec(text);
  const time = /(\d{1,2}):(\d{2})/.exec(text);
  if (!date && !time) return null;

  return resolveDate(
    date ? Number(date[1]) : null,
    date ? Number(date[2]) : null,
    time ? Number(time[1]) : 0,
    time ? Number(time[2]) : 0,
    now,
  );
}

/**
 * 문자에 찍힌 날짜/시각을 연도까지 갖춘 Date 로 만든다.
 * 카드·은행 문자는 연도를 안 적으므로 받은 시각을 기준으로 보정한다.
 * (12/31 문자를 1/1에 받는 경우가 있어 한 달 이상 미래면 작년으로 내린다)
 */
export function resolveDate(month, day, hour, minute, receivedAt) {
  if (!month || !day) return receivedAt;
  const year = receivedAt.getFullYear();
  let d = new Date(year, month - 1, day, hour || 0, minute || 0);
  if (d.getTime() - receivedAt.getTime() > 31 * 24 * 3600 * 1000) {
    d = new Date(year - 1, month - 1, day, hour || 0, minute || 0);
  }
  return d;
}

function hasAny(text, words) {
  return words.some((w) => text.includes(w));
}
