/**
 * 파서 회귀 테스트.
 *
 * ⚠️ 아래 문자들은 실제 수신 문자가 아니라 추정 포맷이다.
 *    진짜 문자 샘플이 생기면 이 파일의 케이스를 실물로 교체하고,
 *    Pattern 시트에 정규식을 넣은 뒤 reprocessAll()을 돌린다.
 *
 * 지금 이 테스트가 검증하는 것은 "현대카드 포맷을 안다"가 아니라
 * "포맷을 몰라도 제네릭 추출기가 금액·종류·앵커를 건져낸다"이다.
 */
const assert = require('assert');
const { load } = require('./harness');

const ctx = load(['Config.gs', 'Util.gs', 'Parse.gs']);
const parse = (body, sender) => ctx.parseMessage_(body, sender, new Date(2026, 8, 15, 12, 0));

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL ' + name + '\n       ' + err.message);
  }
}

console.log('\n현대카드');

check('일시불 승인에서 금액과 종류를 뽑는다', () => {
  const r = parse('[현대카드] 09/15 12:34 승인 5,600원 일시불 스타벅스역삼점', '15771234');
  assert.strictEqual(r.issuer, '현대카드');
  assert.strictEqual(r.kind, 'approval');
  assert.strictEqual(r.amount, 5600);
  assert.strictEqual(r.ok, true);
});

check('월 누적 사용금액을 앵커로 분리한다', () => {
  const r = parse('[현대카드] 09/15 12:34 승인 5,600원 일시불 스타벅스\n누적 342,000원', '15771234');
  assert.strictEqual(r.amount, 5600, '건별 금액이 거래 금액이어야 한다');
  assert.strictEqual(r.cumulative, 342000, '누적은 앵커로 빠져야 한다');
});

check('할부 개월수를 읽는다', () => {
  const r = parse('[현대카드] 09/15 14:02 승인 300,000원 3개월 무신사', '15771234');
  assert.strictEqual(r.installmentMonths, 3);
  assert.strictEqual(r.amount, 300000);
});

check('승인취소를 승인으로 오인하지 않는다', () => {
  const r = parse('[현대카드] 09/16 10:00 승인취소 5,600원 스타벅스', '15771234');
  assert.strictEqual(r.kind, 'cancel', '"승인취소"에는 승인이 들어 있어 순서가 중요하다');
});

check('사용 시각을 문자에서 읽는다', () => {
  const r = parse('[현대카드] 09/15 12:34 승인 5,600원 일시불 스타벅스', '15771234');
  assert.strictEqual(r.occurredAt.getMonth(), 8);
  assert.strictEqual(r.occurredAt.getDate(), 15);
  assert.strictEqual(r.occurredAt.getHours(), 12);
});

console.log('\n우리은행');

check('출금 금액과 잔액을 분리한다', () => {
  const r = parse('[우리] 09/15 12:34 홍길동 출금 5,000 잔액 1,234,567', '15991234');
  assert.strictEqual(r.issuer, '우리은행');
  assert.strictEqual(r.kind, 'withdrawal');
  assert.strictEqual(r.amount, 5000);
  assert.strictEqual(r.balance, 1234567, '잔액이 거래 금액으로 새면 안 된다');
});

check('입금을 수입으로 본다', () => {
  const r = parse('[우리] 09/25 09:00 급여 입금 2,800,000 잔액 3,100,000', '15991234');
  assert.strictEqual(r.kind, 'deposit');
  assert.strictEqual(r.amount, 2800000);
  assert.strictEqual(r.balance, 3100000);
});

// ↓ 여기부터는 실제 수신 문자 포맷. 이름/계좌/잔액만 가렸고 배치는 그대로다.
const REAL_WOORI_DEPOSIT = [
  '[Web발신]',
  '우리 09/19 14:16',
  '*123456',
  '입금 10,000원',
  '홍길동',
  '잔액 500,000원',
].join('\n');

check('[실물] 여러 줄 문자에서 입금액과 잔액을 가른다', () => {
  const r = parse(REAL_WOORI_DEPOSIT, '');
  assert.strictEqual(r.kind, 'deposit');
  assert.strictEqual(r.amount, 10000);
  assert.strictEqual(r.balance, 500000);
  assert.strictEqual(r.ok, true);
});

check('[실물] 은행명이 "우리" 한 단어여도 인식한다', () => {
  const r = parse(REAL_WOORI_DEPOSIT, '');
  assert.strictEqual(r.issuer, '우리은행', '"[우리]"나 "우리은행"만 찾으면 실물을 놓친다');
});

check('[실물] 마스킹된 계좌번호를 금액으로 읽지 않는다', () => {
  const r = parse(REAL_WOORI_DEPOSIT, '');
  assert.notStrictEqual(r.amount, 123456, '*123456은 계좌번호지 돈이 아니다');
});

check('[실물] 보낸 사람 이름을 상대로 남긴다', () => {
  const r = parse(REAL_WOORI_DEPOSIT, '');
  assert.strictEqual(r.merchantRaw, '홍길동', '누가 보냈는지가 더치페이 정산에 쓰인다');
});

check('[실물] 1원 이체도 금액으로 읽는다', () => {
  const r = parse(['[Web발신]', '우리 09/19 14:16', '*123456',
                   '입금 1원', '홍길동', '잔액 500,001원'].join('\n'), '');
  assert.strictEqual(r.amount, 1, '테스트 송금은 보통 1원이라 이게 막히면 첫 확인부터 막힌다');
  assert.strictEqual(r.balance, 500001);
  assert.strictEqual(r.ok, true);
});

// 실제 수신한 현대카드 승인 문자. 이름과 누적액만 가렸다.
const REAL_HYUNDAI_APPROVAL = [
  '[Web발신]',
  '현대 이마트Plus 승인',
  '홍*동',
  '1,800원 일시불',
  '09/19 19:14',
  '컴포즈커피발산',
  '누적1,234,567원',
].join('\n');

check('[실물] 카드 상품명이 붙어도 현대카드로 본다', () => {
  const r = parse(REAL_HYUNDAI_APPROVAL, '');
  assert.strictEqual(r.issuer, '현대카드', '"현대카드"가 아니라 "현대 이마트Plus"로 온다');
});

check('[실물] 승인액과 월 누적액을 가른다', () => {
  const r = parse(REAL_HYUNDAI_APPROVAL, '');
  assert.strictEqual(r.amount, 1800);
  assert.strictEqual(r.cumulative, 1234567, '누적은 앵커로 빠져야 한다');
  assert.strictEqual(r.kind, 'approval');
});

check('[실물] 가맹점은 금액 덩어리도 본인 이름도 아니다', () => {
  const r = parse(REAL_HYUNDAI_APPROVAL, '');
  assert.strictEqual(r.merchantRaw, '컴포즈커피발산',
    '"누적1,234,567원"이나 "홍*동"을 가맹점으로 잡으면 안 된다');
});

check('"원"이 붙은 소액도 금액으로 읽는다', () => {
  const r = parse('[현대카드] 09/15 12:34 승인 50원 일시불 테스트', '15771234');
  assert.strictEqual(r.amount, 50, '세 자리 미만이라고 버리면 안 된다');
});

check('쉼표도 "원"도 없지만 라벨이 붙은 숫자는 금액으로 읽는다', () => {
  const r = parse('[현대카드] 09/15 12:34 승인 5600 일시불 테스트', '15771234');
  assert.strictEqual(r.amount, 5600);
});

check('날짜와 시각을 금액으로 읽지 않는다', () => {
  const r = parse('[현대카드] 09/15 12:34 승인 5,600원 일시불 테스트', '15771234');
  assert.strictEqual(r.amount, 5600, '09, 15, 12, 34 중 하나를 잡으면 안 된다');
});

check('[실물] 문자에 적힌 날짜와 시각을 쓴다', () => {
  const r = parse(REAL_WOORI_DEPOSIT, '');
  assert.strictEqual(r.occurredAt.getMonth(), 8);
  assert.strictEqual(r.occurredAt.getDate(), 19);
  assert.strictEqual(r.occurredAt.getHours(), 14);
  assert.strictEqual(r.occurredAt.getMinutes(), 16);
});

console.log('\n공통');

check('광고 문자는 거래를 만들지 않는다', () => {
  const r = parse('(광고)[현대카드] 이번 달 혜택 안내 10,000원 할인', '15771234');
  assert.strictEqual(r.kind, 'ad');
  assert.strictEqual(r.ok, true, '광고는 실패가 아니라 정상 무시다');
});

check('해석 못 한 문자는 실패로 두고 사유를 남긴다', () => {
  const r = parse('안녕하세요 반갑습니다', '01012345678');
  assert.strictEqual(r.ok, false);
  assert.ok(r.note.length > 0, '인박스에 보여줄 사유가 있어야 한다');
});

check('휴리스틱 결과는 신뢰도가 1.0 미만이다', () => {
  const r = parse('[현대카드] 09/15 12:34 승인 5,600원 일시불 스타벅스', '15771234');
  assert.strictEqual(r.layer, 'generic');
  assert.ok(r.confidence < 1.0, '패턴 없이 뽑은 값은 확정으로 취급하면 안 된다');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
