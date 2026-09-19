import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toleranceFor, expectedFromHeadcount, settlementState, suggestSettlements, netAmount,
} from './settlement.js';

test('인원수를 주면 내 몫을 뺀 나머지를 회수 예상액으로 잡는다', () => {
  assert.equal(expectedFromHeadcount(93800, 4), 70350, '4명이면 나 뺀 3명 몫이다');
  assert.equal(expectedFromHeadcount(40000, 2), 20000);
});

test('보낸 금액이 제각각이어도 오차 안이면 닫힌다', () => {
  const s = { expectedAmount: 70350, tolerance: toleranceFor(70350) };
  const links = [{ amount: 23450 }, { amount: 23500 }, { amount: 24000 }];
  const r = settlementState(s, links);

  assert.equal(r.received, 70950);
  assert.equal(r.remaining, -600, '600원 더 받았다');
  assert.equal(r.settled, true, `허용 오차 ${r.tolerance}원 안이다`);
});

test('한 명이 안 보내면 열린 채로 남는다', () => {
  const s = { expectedAmount: 70350 };
  const r = settlementState(s, [{ amount: 23450 }, { amount: 23450 }]);
  assert.equal(r.remaining, 23450);
  assert.equal(r.settled, false);
});

test('허용 오차는 적어도 1,000원이다', () => {
  assert.equal(toleranceFor(5000), 1000, '작은 금액에서 5%면 너무 빡빡하다');
  assert.equal(toleranceFor(100000), 5000);
});

test('통계에 잡히는 금액은 총액이 아니라 내 순부담이다', () => {
  const txn = { amount: 93800, settlementId: 's1' };
  const settlements = [{ id: 's1', receivedAmount: 70350 }];
  assert.equal(netAmount(txn, settlements), 23450, '9만 쓰고 7만 받았으면 내 돈은 2만이다');
});

test('정산이 안 걸린 거래는 총액 그대로다', () => {
  assert.equal(netAmount({ amount: 5000, settlementId: null }, []), 5000);
});

test('입금액에 가까운 열린 정산을 후보로 올린다', () => {
  const settlements = [{ id: 's1', txnId: 't1', status: 'open', expectedAmount: 70350 }];
  const found = suggestSettlements(23500, settlements, []);
  assert.equal(found.length, 1);
  assert.equal(found[0].settlementId, 's1');
});

test('남은 금액보다 크게 들어온 입금은 후보에서 뺀다', () => {
  const settlements = [{ id: 's1', txnId: 't1', status: 'open', expectedAmount: 20000 }];
  assert.equal(suggestSettlements(2800000, settlements, []).length, 0,
    '급여 입금이 정산 후보로 뜨면 안 된다');
});

test('닫힌 정산은 후보에 올리지 않는다', () => {
  const settlements = [{ id: 's1', txnId: 't1', status: 'closed', expectedAmount: 20000 }];
  assert.equal(suggestSettlements(20000, settlements, []).length, 0);
});
