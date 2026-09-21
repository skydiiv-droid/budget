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

// ───────────────────────────────────────────────── 여러 통 자르기

import { splitMessages } from './parse.js';

const HYUNDAI = (amount, cum) => `[Web발신]
현대 이마트Plus 승인
신*우
${amount}원 일시불
09/19 19:14
컴포즈커피발산
누적${cum}원`;

test('붙여 넣은 여러 통을 한 통씩 자른다', () => {
  const both = HYUNDAI('1,800', '3,634,067') + '\n' + HYUNDAI('4,300', '3,638,367');
  const out = splitMessages(both);
  assert.equal(out.length, 2, '열 건을 열 번 공유하게 둘 수는 없다');
  assert.ok(out[0].includes('1,800') && !out[0].includes('4,300'));
  assert.ok(out[1].startsWith('[Web발신]'));
});

test('한 통이면 한 통으로 둔다', () => {
  assert.deepEqual(splitMessages(HYUNDAI('1,800', '3,634,067')).length, 1);
});

test('[Web발신] 이 없으면 빈 줄로 가른다', () => {
  const two = '우리 09/19 14:16\n출금 30,000\n잔액 812,400\n\n우리 09/19 15:02\n입금 50,000\n잔액 862,400';
  assert.equal(splitMessages(two).length, 2);
});

test('한 통 안의 빈 줄 때문에 쪼개지 않는다', () => {
  const one = '현대 이마트Plus 승인\n\n1,800원 일시불\n\n컴포즈커피발산';
  assert.equal(splitMessages(one).length, 1, '억지로 자르면 한 건이 두 건이 된다');
});

test('빈 글은 아무것도 안 준다', () => {
  assert.deepEqual(splitMessages(''), []);
  assert.deepEqual(splitMessages('   \n  '), []);
});

// ── 현대 · 우리 말고도 읽히는가 ───────────────────────────
//
// 주의: 아래 문자는 **직접 지어낸 것**이다. 실제 포맷을 받아 본 적이 없다.
// 그래서 이 검사가 말해 주는 건 "이 곳들의 포맷을 지원한다"가 아니라
// "포맷을 몰라도 금액·종류·가맹점은 건져낸다"뿐이다.
// 진짜 문자를 받으면 안 맞는 데가 나올 수 있고, 그때 여기에 더하면 된다.

const ONLY_KNOWN = '발급사 이름을 알아본다';

test(`신한카드 ${ONLY_KNOWN}`, () => {
  const t = '[Web발신]\n신한카드(1234) 승인\n홍*동\n12,000원 일시불\n09/21 13:02\n스타벅스역삼점';
  const r = parseMessage(t, '15447000', new Date('2026-09-21T13:02:00'));
  assert.equal(r.issuer, '신한카드');
  assert.equal(r.kind, 'approval');
  assert.equal(r.amount, 12_000);
  assert.ok(r.ok);
});

test(`삼성카드 ${ONLY_KNOWN}`, () => {
  const t = '[Web발신]\n삼성카드 승인\n7,900원 일시불\n09/21 11:20\nGS25서구탑병원점';
  const r = parseMessage(t, '', new Date('2026-09-21T11:20:00'));
  assert.equal(r.issuer, '삼성카드');
  assert.equal(r.amount, 7_900);
  assert.equal(r.merchantRaw, 'GS25서구탑병원점');
});

test(`KB국민 ${ONLY_KNOWN}`, () => {
  const t = '[Web발신]\nKB국민 체크카드 승인\n3,500원\n09/21 08:05\n컴포즈커피';
  const r = parseMessage(t, '', new Date('2026-09-21T08:05:00'));
  assert.equal(r.issuer, 'KB국민카드');
  assert.equal(r.amount, 3_500);
});

test(`카카오페이 ${ONLY_KNOWN}`, () => {
  const t = '[Web발신]\n카카오페이 결제\n15,000원\n배달의민족';
  const r = parseMessage(t, '', new Date('2026-09-21T19:00:00'));
  assert.equal(r.issuer, '카카오페이');
  assert.equal(r.kind, 'approval');
  assert.equal(r.amount, 15_000);
});

test('같은 이름이라도 은행 문자와 카드 문자를 가른다', () => {
  const card = parseMessage('[Web발신]\n신한 체크카드 승인\n4,000원\n김밥천국', '',
    new Date('2026-09-21T12:00:00'));
  assert.equal(card.issuer, '신한카드');

  const bank = parseMessage('[Web발신]\n신한 09/21 12:00\n출금 50,000\n잔액 812,400', '',
    new Date('2026-09-21T12:00:00'));
  assert.equal(bank.issuer, '신한은행');
  assert.equal(bank.kind, 'withdrawal');
  assert.equal(bank.balance, 812_400);
});

test('본문 한가운데 나오는 이름은 가맹점이지 발급사가 아니다', () => {
  // 우리은행에서 현대백화점 결제 — 현대카드로 읽으면 엉뚱한 카드에 붙는다
  const r = parseMessage('[Web발신]\n우리 09/21 15:00\n출금 88,000\n현대백화점\n잔액 500,000', '',
    new Date('2026-09-21T15:00:00'));
  assert.equal(r.issuer, '우리은행');
});

test('자동이체와 송금도 나간 돈으로 본다', () => {
  for (const word of ['자동이체', '송금', '납부']) {
    const r = parseMessage(`[Web발신]\n우리 09/21 09:00\n${word} 38,400\n잔액 700,000`, '',
      new Date('2026-09-21T09:00:00'));
    assert.equal(r.kind, 'withdrawal', word);
    assert.equal(r.amount, 38_400, word);
  }
});

test('타행 입금은 들어온 돈이다 — "이체"가 붙어 있어도', () => {
  const r = parseMessage('[Web발신]\n우리 09/05 09:00\n타행이체 입금 2,950,000\n잔액 3,100,000', '',
    new Date('2026-09-05T09:00:00'));
  assert.equal(r.kind, 'deposit');
});

test('모르는 곳에서 와도 금액과 종류는 건져낸다', () => {
  const r = parseMessage('[Web발신]\n어디카드 승인\n5,600원\n이름모를가게', '',
    new Date('2026-09-21T10:00:00'));
  assert.equal(r.issuer, '', '이름은 모른다');
  assert.equal(r.kind, 'approval');
  assert.equal(r.amount, 5_600);
  assert.ok(r.ok, '발급사를 몰라도 거래로는 들어간다');
});

test('카드 상품명은 발급사를 가리지 않고 뽑는다', () => {
  assert.equal(detectCardName('신한 딥드림 승인'), '딥드림');
  assert.equal(detectCardName('현대 이마트Plus 승인'), '이마트Plus');
  assert.equal(detectCardName('KB국민 탄탄대로 결제'), '탄탄대로');
  assert.equal(detectCardName('현대 승인'), '', '상품명이 없으면 없는 것이다');
});

test('카드대금이 통장에서 빠지는 문자는 은행 것이다', () => {
  // "결제"가 들어 있어도 잔액이 찍혀 있으면 은행 문자다
  const r = parseMessage('[Web발신]\n우리 10/12 09:00\n현대카드대금 결제 820,605\n잔액 500,000', '',
    new Date('2026-10-12T09:00:00'));
  assert.equal(r.issuer, '우리은행');
  assert.equal(r.balance, 500_000);
});
