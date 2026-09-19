/** 공통 유틸. */

function newId_(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

/**
 * 같은 문자가 두 번 들어와도 한 건으로 취급하기 위한 키.
 *
 * 받은 시각은 쓰지 않고 원문만 쓴다. 놓친 문자를 나중에 공유 시트로 보낼 때
 * 받은 시각이 달라지는데, 그것까지 넣으면 같은 결제가 두 건이 되기 때문이다.
 *
 * 원문만으로 충분한 이유: 카드 문자에는 월 누적이, 은행 문자에는 잔액이 함께
 * 찍힌다. 둘 다 거래마다 달라지므로 서로 다른 거래의 원문이 같을 수 없다.
 */
function dedupeKey_(body) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5, String(body || ''), Utilities.Charset.UTF_8);
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
