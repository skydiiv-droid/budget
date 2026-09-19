/**
 * 파서 회귀 테스트.
 *
 * [실물] 로 표시한 것은 실제 수신 문자다. 이름·계좌·잔액만 가렸고
 * 줄바꿈과 구분자 배치는 그대로다. 정규식이 거기에 걸린다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMessage, extractAmounts, extractMerchant, normalizeMerchant, detectCardName,
} from './parse.js';

const AT = new Date(2026, 8, 19, 19, 14);
const parse = (body, sender = '') => parseMessage(body, sender, AT);

const REAL_HYUNDAI = [
  '[Web발신]',
  '현대 이마트Plus 승인',
  '홍*동',
  '1,800원 일시불',
  '09/19 19:14',
  '컴포즈커피발산',
  '누적1,234,567원',
].join('\n');

const REAL_WOORI = [
  '[Web발신]',
  '우리 09/19 14:16',
  '*123456',
  '입금 1원',
  '홍길동',
  '잔액 500,001원',
].join('\n');

test('[실물] 카드 상품명이 붙어도 현대카드로 본다', () => {
  assert.equal(parse(REAL_HYUNDAI).issuer, '현대카드');
  assert.equal(parse(REAL_HYUNDAI).cardName, '이마트Plus');
});

test('[실물] 승인액과 월 누적액을 가른다', () => {
  const r = parse(REAL_HYUNDAI);
  assert.equal(r.amount, 1800);
  assert.equal(r.cumulative, 1234567, '누적은 앵커로 빠져야 한다');
  assert.equal(r.kind, 'approval');
});

test('[실물] 가맹점은 금액 덩어리도 본인 이름도 아니다', () => {
  assert.equal(parse(REAL_HYUNDAI).merchantRaw, '컴포즈커피발산');
});

test('[실물] 다른 카드는 상품명으로 갈린다', () => {
  const r = parse(['[Web발신]', '현대 미래에셋 승인', '홍*동', '9,900원 일시불',
                   '09/20 08:30', '메가커피화곡', '누적120,000원'].join('\n'));
  assert.equal(r.cardName, '미래에셋', '카드마다 누적이 따로 오므로 갈라야 한다');
  assert.equal(r.amount, 9900);
  assert.equal(r.cumulative, 120000);
});

test('[실물] 은행명이 "우리" 한 단어여도 인식한다', () => {
  assert.equal(parse(REAL_WOORI).issuer, '우리은행');
});

test('[실물] 1원 이체도 금액으로 읽는다', () => {
  const r = parse(REAL_WOORI);
  assert.equal(r.amount, 1, '테스트 송금은 보통 1원이라 이게 막히면 첫 확인부터 막힌다');
  assert.equal(r.balance, 500001);
  assert.equal(r.kind, 'deposit');
  assert.equal(r.ok, true);
});

test('[실물] 마스킹된 계좌번호를 금액으로 읽지 않는다', () => {
  assert.notEqual(parse(REAL_WOORI).amount, 123456, '*123456은 계좌번호지 돈이 아니다');
});

test('[실물] 보낸 사람 이름을 상대로 남긴다', () => {
  assert.equal(parse(REAL_WOORI).merchantRaw, '홍길동', '누가 보냈는지가 정산에 쓰인다');
});

test('[실물] 문자에 적힌 날짜와 시각을 쓴다', () => {
  const r = parse(REAL_WOORI);
  assert.equal(r.occurredAt.getMonth(), 8);
  assert.equal(r.occurredAt.getDate(), 19);
  assert.equal(r.occurredAt.getHours(), 14);
  assert.equal(r.occurredAt.getMinutes(), 16);
});

test('승인취소를 승인으로 오인하지 않는다', () => {
  const r = parse('[현대카드] 09/16 10:00 승인취소 5,600원 스타벅스');
  assert.equal(r.kind, 'cancel', '"승인취소"에는 승인이 들어 있어 순서가 중요하다');
});

test('할부 개월수를 읽는다', () => {
  const r = parse('[현대카드] 09/15 14:02 승인 300,000원 3개월 무신사');
  assert.equal(r.installmentMonths, 3);
  assert.equal(r.amount, 300000);
});

test('"원"이 붙은 소액도 금액으로 읽는다', () => {
  assert.equal(parse('[현대카드] 09/15 12:34 승인 50원 일시불 테스트').amount, 50);
});

test('쉼표도 "원"도 없지만 라벨이 붙은 숫자는 금액으로 읽는다', () => {
  assert.equal(parse('[현대카드] 09/15 12:34 승인 5600 일시불 테스트').amount, 5600);
});

test('날짜와 시각을 금액으로 읽지 않는다', () => {
  const r = parse('[현대카드] 09/15 12:34 승인 5,600원 일시불 테스트');
  assert.equal(r.amount, 5600, '09, 15, 12, 34 중 하나를 잡으면 안 된다');
});

test('광고 문자는 거래를 만들지 않는다', () => {
  const r = parse('(광고)[현대카드] 이번 달 혜택 안내 10,000원 할인');
  assert.equal(r.kind, 'ad');
  assert.equal(r.ok, true, '광고는 실패가 아니라 정상 무시다');
});

test('해석 못 한 문자는 실패로 두고 사유를 남긴다', () => {
  const r = parse('안녕하세요 반갑습니다');
  assert.equal(r.ok, false);
  assert.ok(r.note.length > 0, '인박스에 보여 줄 사유가 있어야 한다');
});

test('휴리스틱 결과는 신뢰도가 1.0 미만이다', () => {
  const r = parse(REAL_HYUNDAI);
  assert.equal(r.layer, 'generic');
  assert.ok(r.confidence < 1.0, '패턴 없이 뽑은 값을 확정으로 취급하면 안 된다');
});

test('패턴이 있으면 휴리스틱보다 먼저 쓴다', () => {
  const patterns = [{
    issuer: '현대카드',
    kind: 'approval',
    priority: 10,
    enabled: true,
    // 실물 배치: 승인 → 이름 → 금액 일시불 → 날짜 → 가맹점 → 누적
    regex: '승인[\\s\\S]*?([\\d,]+)원\\s+일시불[\\s\\S]*?\\n([가-힣A-Za-z]+)\\n누적',
    fields: { 1: 'amount', 2: 'merchantRaw' },
  }];
  const r = parseMessage(REAL_HYUNDAI, '', AT, patterns);
  assert.equal(r.layer, 'pattern');
  assert.equal(r.confidence, 1.0);
  assert.equal(r.amount, 1800);
  assert.equal(r.merchantRaw, '컴포즈커피발산');
});

test('잘못 적은 정규식은 건너뛰고 휴리스틱으로 간다', () => {
  const patterns = [{ enabled: true, regex: '([', fields: {}, kind: 'approval' }];
  const r = parseMessage(REAL_HYUNDAI, '', AT, patterns);
  assert.equal(r.layer, 'generic', '패턴 하나가 틀렸다고 전체가 죽으면 안 된다');
  assert.equal(r.amount, 1800);
});

test('가맹점 이름을 견줄 수 있게 다듬는다', () => {
  assert.equal(normalizeMerchant('(주)스타벅스코리아 역삼점1234'), '스타벅스코리아역삼점');
  assert.equal(normalizeMerchant(''), '');
  assert.equal(normalizeMerchant(null), '');
});

test('금액 후보에 역할이 붙는다', () => {
  const found = extractAmounts('입금 1,000원 잔액 50,000원');
  assert.equal(found.length, 2);
  assert.equal(found[0].role, 'amount');
  assert.equal(found[1].role, 'balance');
});

test('가맹점을 못 찾으면 null 이다', () => {
  assert.equal(extractMerchant('12,345'), null);
});

test('카드 문자가 아니면 상품명은 비어 있다', () => {
  assert.equal(detectCardName(REAL_WOORI), '');
});
