import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKeywords, hitsRecurring, dueDateOf, fixedStatus, lateFixed,
         candidates, liveRecurring, learnKeyword, knownKeyword } from './fixed.js';

const netflix = {
  id: 'r1', name: '넷플릭스', expectedAmount: 17_000, dayOfMonth: 15, period: 'monthly',
};

test('키워드는 쉼표와 줄바꿈으로 가른다', () => {
  assert.deepEqual(parseKeywords('NETFLIX, 넷플릭스\n netflix.com '),
    ['NETFLIX', '넷플릭스', 'netflix.com']);
  assert.deepEqual(parseKeywords(['A', ' B ']), ['A', 'B']);
  assert.deepEqual(parseKeywords(''), []);
  assert.deepEqual(parseKeywords(null), []);
});

test('이름이 가맹점에 들어 있으면 그 고정지출이다', () => {
  assert.equal(hitsRecurring({ merchantRaw: '넷플릭스코리아' }, netflix), true);
  assert.equal(hitsRecurring({ merchantRaw: '쿠팡' }, netflix), false);
});

test('문자에 찍히는 말이 이름과 달라도 키워드로 찾는다', () => {
  const r = { ...netflix, keywords: 'NETFLIX.COM' };
  assert.equal(hitsRecurring({ merchantRaw: 'NETFLIX.COM' }, r), true);
  assert.equal(hitsRecurring({ merchantRaw: 'netflix com' }, r), true);
});

test('결제 수단을 정해 두면 다른 데서 긁힌 건 아니다', () => {
  const r = { ...netflix, accountId: 'c1' };
  assert.equal(hitsRecurring({ merchantRaw: '넷플릭스', accountId: 'c1' }, r), true);
  assert.equal(hitsRecurring({ merchantRaw: '넷플릭스', accountId: 'c2' }, r), false);
  // 어느 계좌인지 모르는 거래까지 쳐내면 멀쩡한 걸 놓친다
  assert.equal(hitsRecurring({ merchantRaw: '넷플릭스' }, r), true);
});

test('카드 이름만 붙은 거래도 결제 수단으로 가른다', () => {
  const accounts = [
    { id: 'c1', type: 'card', name: '현대 미래에셋', active: true },
    { id: 'c2', type: 'card', name: '현대 이마트', active: true },
  ];
  const r = { ...netflix, accountId: 'c1' };
  assert.equal(hitsRecurring({ merchantRaw: '넷플릭스', cardName: '미래에셋' }, r, accounts), true);
  assert.equal(hitsRecurring({ merchantRaw: '넷플릭스', cardName: '이마트' }, r, accounts), false);
});

test('연 1회짜리는 그 달에만 예정일이 있다', () => {
  const car = { id: 'r2', name: '자동차보험', period: 'yearly', monthOfYear: 4, dayOfMonth: 20 };
  assert.equal(dueDateOf(car, '2026-04').getDate(), 20);
  assert.equal(dueDateOf(car, '2026-05'), null);
});

test('31일짜리는 그 달 말일로 당긴다', () => {
  const d = dueDateOf({ dayOfMonth: 31, period: 'monthly' }, '2026-02');
  assert.equal(d.getMonth(), 1);
  assert.equal(d.getDate(), 28);
});

test('예정일이 평일이면 다음 날까지 기다린다', () => {
  const data = { recurring: [netflix], transactions: [] };
  // 2026-09-15 는 화요일
  const waiting = fixedStatus(data, '2026-09', new Date('2026-09-16T12:00:00'))[0];
  assert.equal(waiting.state, 'waiting');

  const late = fixedStatus(data, '2026-09', new Date('2026-09-17T09:00:00'))[0];
  assert.equal(late.state, 'late');
  assert.equal(late.shifted, false);
});

test('예정일이 쉬는 날이면 다음 영업일에서 하루를 더 준다', () => {
  // 2026-08-15 광복절(토) → 대체공휴일 17일(월) → 실제 출금 18일(화) → 19일까지 기다린다
  const r = { ...netflix, dayOfMonth: 15 };
  const data = { recurring: [r], transactions: [] };

  const still = fixedStatus(data, '2026-08', new Date('2026-08-19T12:00:00'))[0];
  assert.equal(still.state, 'waiting');
  assert.equal(still.shifted, true);
  assert.equal(still.settled.getDate(), 18);

  const late = fixedStatus(data, '2026-08', new Date('2026-08-20T09:00:00'))[0];
  assert.equal(late.state, 'late');
  assert.equal(late.daysLate, 1);
});

test('문자로 들어왔으면 확인된 것으로 본다', () => {
  const data = {
    recurring: [netflix],
    transactions: [{
      id: 't1', type: 'expense', amount: 17_000,
      occurredAt: '2026-09-15T04:10:00', merchantRaw: '넷플릭스', source: 'sms',
    }],
  };
  const row = fixedStatus(data, '2026-09', new Date('2026-09-20T09:00:00'))[0];
  assert.equal(row.state, 'paid');
  assert.equal(row.amount, 17_000);
  assert.equal(row.diff, 0);
});

test('취소된 건은 들어온 것으로 치지 않는다', () => {
  const data = {
    recurring: [netflix],
    transactions: [{
      id: 't1', type: 'expense', amount: 17_000, status: 'voided',
      occurredAt: '2026-09-15T04:10:00', merchantRaw: '넷플릭스',
    }],
  };
  assert.equal(fixedStatus(data, '2026-09', new Date('2026-09-20T09:00:00'))[0].state, 'late');
});

test('금액이 다르면 얼마나 다른지 적는다', () => {
  const phone = { id: 'r3', name: 'SKT', expectedAmount: 55_000, dayOfMonth: 10 };
  const data = {
    recurring: [phone],
    transactions: [{ id: 't1', type: 'expense', amount: 71_200,
      occurredAt: '2026-09-10T04:00:00', merchantRaw: 'SKT통신요금' }],
  };
  assert.equal(fixedStatus(data, '2026-09', new Date('2026-09-20T09:00:00'))[0].diff, 16_200);
});

test('금액이 달마다 다른 건은 견주지 않는다', () => {
  const phone = { id: 'r3', name: 'SKT', expectedAmount: 55_000, dayOfMonth: 10, amountVaries: true };
  const data = {
    recurring: [phone],
    transactions: [{ id: 't1', type: 'expense', amount: 71_200,
      occurredAt: '2026-09-10T04:00:00', merchantRaw: 'SKT통신요금' }],
  };
  const row = fixedStatus(data, '2026-09', new Date('2026-09-20T09:00:00'))[0];
  assert.equal(row.diff, 0);
  assert.equal(row.varies, true);
});

test('결제일을 안 적어 두면 지켜보지 않는다', () => {
  const r = { id: 'r4', name: '어딘가', expectedAmount: 10_000 };
  assert.equal(fixedStatus({ recurring: [r] }, '2026-09', new Date('2026-09-20'))[0].state, 'idle');
});

test('안 들어온 것만 골라 늦은 순으로 준다', () => {
  const data = {
    recurring: [
      { id: 'a', name: '가', dayOfMonth: 5, expectedAmount: 1 },
      { id: 'b', name: '나', dayOfMonth: 15, expectedAmount: 1 },
      { id: 'c', name: '다', dayOfMonth: 28, expectedAmount: 1 },
    ],
    transactions: [],
  };
  const rows = lateFixed(fixedStatus(data, '2026-09', new Date('2026-09-20T09:00:00')));
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b']);
});

test('해지하면 더는 지켜보지 않는다', () => {
  const ended = { ...netflix, active: false };
  const rows = fixedStatus({ recurring: [ended], transactions: [] }, '2026-09', new Date('2026-09-20T09:00:00'));
  assert.equal(rows[0].state, 'ended');
  assert.deepEqual(lateFixed(rows), []);
});

test('이번 달만 넘기면 알림이 사라지고 다음 달엔 다시 지켜본다', () => {
  const r = { ...netflix, skipMonths: ['2026-09'] };
  const data = { recurring: [r], transactions: [] };
  assert.equal(fixedStatus(data, '2026-09', new Date('2026-09-20T09:00:00'))[0].state, 'skipped');
  assert.equal(fixedStatus(data, '2026-10', new Date('2026-10-20T09:00:00'))[0].state, 'late');
});

test('손으로 이어 붙인 거래는 이름이 안 맞아도 받아들인다', () => {
  const data = {
    recurring: [netflix],
    transactions: [{
      id: 't1', type: 'expense', amount: 17_000, recurringId: 'r1',
      occurredAt: '2026-09-15T04:10:00', merchantRaw: 'NF KOREA 0915',
    }],
  };
  const row = fixedStatus(data, '2026-09', new Date('2026-09-20T09:00:00'))[0];
  assert.equal(row.state, 'paid');
  assert.equal(row.txn.id, 't1');
});

test('이어 붙인 거래는 기한을 넘겨 들어왔어도 받아들인다', () => {
  // 16일이 기한인데 22일에 찍혔다. 사람이 보고 고른 것이라 자동 판정보다 세다.
  const data = {
    recurring: [netflix],
    transactions: [{
      id: 't1', type: 'expense', amount: 17_000, recurringId: 'r1',
      occurredAt: '2026-09-22T04:10:00', merchantRaw: '어딘가',
    }],
  };
  assert.equal(fixedStatus(data, '2026-09', new Date('2026-09-25T09:00:00'))[0].state, 'paid');
});

test('다른 고정지출에 이어 붙인 거래는 이쪽 것이 아니다', () => {
  const txn = { id: 't1', type: 'expense', amount: 17_000, recurringId: 'r9', merchantRaw: '넷플릭스' };
  assert.equal(hitsRecurring(txn, netflix), false);
});

test('"출금됐다"고 할 때 고를 거래는 금액과 날짜가 가까운 순이다', () => {
  const txns = [
    { id: 'far', type: 'expense', amount: 17_000, occurredAt: '2026-09-25T10:00:00', merchantRaw: '가' },
    { id: 'near', type: 'expense', amount: 17_000, occurredAt: '2026-09-15T10:00:00', merchantRaw: '나' },
    { id: 'off', type: 'expense', amount: 90_000, occurredAt: '2026-09-15T11:00:00', merchantRaw: '다' },
    { id: 'out', type: 'expense', amount: 17_000, occurredAt: '2026-08-01T10:00:00', merchantRaw: '라' },
    { id: 'mine', type: 'expense', amount: 17_000, occurredAt: '2026-09-16T10:00:00', recurringId: 'r9', merchantRaw: '마' },
  ];
  const ids = candidates(netflix, txns, '2026-09').map((t) => t.id);
  assert.equal(ids[0], 'near');
  assert.ok(!ids.includes('out'), '주기 밖의 거래는 빼야 한다');
  assert.ok(!ids.includes('mine'), '다른 고정지출에 이미 붙은 거래는 빼야 한다');
});

test('금액이 달마다 다른 건은 날짜만 보고 고른다', () => {
  const phone = { id: 'r3', name: 'SKT', expectedAmount: 55_000, dayOfMonth: 10, amountVaries: true };
  const txns = [
    { id: 'same', type: 'expense', amount: 55_000, occurredAt: '2026-09-18T10:00:00', merchantRaw: '가' },
    { id: 'near', type: 'expense', amount: 120_000, occurredAt: '2026-09-10T10:00:00', merchantRaw: '나' },
  ];
  assert.equal(candidates(phone, txns, '2026-09')[0].id, 'near');
});

test('해지한 것은 한 달 고정지출에서 빠진다', () => {
  assert.deepEqual(liveRecurring([netflix, { ...netflix, id: 'r2', active: false }]).map((r) => r.id), ['r1']);
});

test('고정지출이 사라진 뒤 남은 연결은 어느 것에도 안 붙는다', () => {
  // 이어 붙인 고정지출을 지우면 거래에 recurringId 만 남는다.
  // 그 거래는 다른 어떤 고정지출로도 안 잡히고, 골라 이을 수도 없게 된다.
  const orphan = { id: 't1', type: 'expense', amount: 17_000,
    occurredAt: '2026-09-15T04:10:00', merchantRaw: '넷플릭스', recurringId: 'r_없어진것' };

  assert.equal(hitsRecurring(orphan, netflix), false, '이름이 맞아도 안 붙는다');
  assert.deepEqual(candidates(netflix, [orphan], '2026-09'), [], '고를 수도 없다');

  const row = fixedStatus({ recurring: [netflix], transactions: [orphan] },
    '2026-09', new Date('2026-09-20T09:00:00'))[0];
  assert.equal(row.state, 'late', '들어왔는데도 안 들어온 것으로 센다');
});

// ── 고정지출과 거래를 맞추는 힘 ──────────────────────────
// 아래 것들은 모두 한 번씩 놓쳤던 자리다.

test('적어 둔 이름의 대소문자까지 맞아야 할 이유는 없다', () => {
  // "Netflix" 로 적어 두고 문자에는 "NETFLIX.COM" 이 찍힌다.
  const r = { ...netflix, name: 'Netflix' };
  assert.equal(hitsRecurring({ merchantRaw: 'NETFLIX.COM', amount: 17_000 }, r), true);
  assert.equal(hitsRecurring({ merchantRaw: 'netflix korea', amount: 17_000 }, r), true);
});

test('가맹점을 엉뚱하게 끊어 읽었어도 본문에 이름이 있으면 찾는다', () => {
  // 은행 출금 문자는 가맹점 자리가 "우리은행"으로 잡히기 쉽다.
  const r = { id: 'r5', name: '관리비', expectedAmount: 123_000, dayOfMonth: 25 };
  const txn = { merchantRaw: '우리은행', amount: 131_450,
    rawText: '[우리은행] 09/25 10:02 출금 131,450원 관리비 잔액 412,300원' };
  assert.equal(hitsRecurring(txn, r), true);
});

test('받쳐 줄 금액이 없으면 본문만 보고 짐작하지 않는다', () => {
  // 금액이 달마다 다르다고 해 두면 견줄 것이 없다. 그때까지 짐작하면
  // 안 들어온 것을 안 들어왔다고 말할 수 없게 된다.
  const r = { id: 'r5', name: '관리비', expectedAmount: 123_000, dayOfMonth: 25, amountVaries: true };
  const txn = { merchantRaw: '우리은행', amount: 131_450,
    rawText: '[우리은행] 09/25 출금 131,450원 관리비' };
  assert.equal(hitsRecurring(txn, r), false);
});

test('적어 둔 이름이 문자에 찍힌 것보다 길어도 금액이 받쳐 주면 찾는다', () => {
  const r = { id: 'r6', name: '유튜브프리미엄', expectedAmount: 14_900, dayOfMonth: 6 };
  assert.equal(hitsRecurring({ merchantRaw: '유튜브', amount: 14_900 }, r), true);
  // 금액이 영 다르면 같은 건으로 보지 않는다
  assert.equal(hitsRecurring({ merchantRaw: '유튜브', amount: 89_000 }, r), false);
});

test('한 글자 키워드는 아무 문자에나 걸리므로 쓰지 않는다', () => {
  const r = { ...netflix, keywords: '커' };
  assert.equal(hitsRecurring({ merchantRaw: '컴포즈커피', amount: 4_500 }, r), false);
});

test('한 거래가 두 고정지출을 메우지는 못한다', () => {
  // 둘 다 "들어왔다"가 되면 진짜 안 들어온 쪽이 조용히 묻힌다.
  const data = {
    recurring: [
      { id: 'a', name: '넷플릭스', expectedAmount: 17_000, dayOfMonth: 15 },
      { id: 'b', name: '넷플릭스', expectedAmount: 5_500, dayOfMonth: 15 },
    ],
    transactions: [{ id: 't1', type: 'expense', amount: 17_000,
      occurredAt: '2026-09-15T04:10:00', merchantRaw: '넷플릭스' }],
  };
  const rows = fixedStatus(data, '2026-09', new Date('2026-09-20T09:00:00'));
  assert.deepEqual(rows.map((r) => r.state), ['paid', 'late']);
  assert.equal(rows[0].txn.id, 't1');
});

test('여럿이 걸리면 금액이 가까운 건을 고른다', () => {
  // 날짜만 보면 먼저 찍힌 1,000원짜리를 집는다. 그것은 넷플릭스 결제가 아니다.
  const data = {
    recurring: [netflix],
    transactions: [
      { id: 'tiny', type: 'expense', amount: 1_000,
        occurredAt: '2026-09-14T04:00:00', merchantRaw: '넷플릭스' },
      { id: 'real', type: 'expense', amount: 17_000,
        occurredAt: '2026-09-15T04:10:00', merchantRaw: '넷플릭스' },
    ],
  };
  const row = fixedStatus(data, '2026-09', new Date('2026-09-20T09:00:00'))[0];
  assert.equal(row.txn.id, 'real');
  assert.equal(row.diff, 0);
});

test('적금 자동이체도 "출금됐다"고 할 때 고를 수 있다', () => {
  // 지출만 보여 주면 저축으로 돌린 자동이체는 목록에 아예 안 뜬다.
  const save = { id: 'r7', name: '청약', expectedAmount: 100_000, dayOfMonth: 25 };
  const txns = [{ id: 'tr1', type: 'transfer', amount: 100_000,
    occurredAt: '2026-09-25T04:00:00', merchantRaw: '주택청약' }];
  assert.deepEqual(candidates(save, txns, '2026-09').map((t) => t.id), ['tr1']);
});

test('이름이나 키워드가 걸리는 건을 위로 올린다', () => {
  const txns = [
    { id: 'other', type: 'expense', amount: 17_000, occurredAt: '2026-09-15T09:00:00', merchantRaw: '편의점' },
    { id: 'nf', type: 'expense', amount: 17_000, occurredAt: '2026-09-18T09:00:00', merchantRaw: '넷플릭스' },
  ];
  assert.equal(candidates(netflix, txns, '2026-09')[0].id, 'nf');
});

test('배울 키워드에서 매달 바뀌는 꼬리는 뗀다', () => {
  // "넷플릭스서비시스 0915" 를 그대로 배우면 다음 달에는 안 맞는다.
  assert.equal(learnKeyword('넷플릭스서비시스 0915'), '넷플릭스서비시스');
  assert.equal(learnKeyword('GOOGLE YOUTUBEPREMIUM'), 'GOOGLE YOUTUBEPREMIUM');
  // 떼고 나면 너무 짧아지는 것은 그대로 둔다 (GS25 → GS 는 아무 데나 걸린다)
  assert.equal(learnKeyword('GS25'), 'GS25');
  assert.equal(learnKeyword(''), '');
  assert.equal(learnKeyword(null), '');
});

test('이미 잡히는 이름은 다시 배우지 않는다', () => {
  assert.equal(knownKeyword(netflix, '넷플릭스코리아'), true);
  assert.equal(knownKeyword({ ...netflix, keywords: 'netflix' }, 'NETFLIX.COM 0915'), true);
  assert.equal(knownKeyword(netflix, 'NF KOREA'), false);
});
