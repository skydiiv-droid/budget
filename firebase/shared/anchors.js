/**
 * 문자에 찍힌 숫자와 우리가 센 숫자를 맞춰 본다.
 *
 * 아이폰은 다른 앱 알림을 못 읽는다. 그래서 문자가 유일한 길인데, 문자도
 * 놓친다 — 잠겨 있었거나, 저전력이었거나, iOS 를 막 업데이트했거나.
 * 놓친 걸 놓친 줄 모르는 게 제일 나쁘다. 합계가 조용히 틀려 있으니까.
 *
 * 다행히 카드 문자에는 그달 **누적**이, 은행 문자에는 **잔액**이 함께 찍힌다.
 * 그건 카드사·은행이 센 숫자라 진실이다. 우리 합계와 견주면 얼마나 빠졌는지
 * 정확히 나온다.
 *
 *   누적 3,634,067  (카드사가 센 것)
 *   우리 3,601,167
 *   ─────────────
 *   차이    32,900  ← 이만큼 어딘가 안 들어왔다
 */

import { cardGroup, inCards, alive, isCard } from './accounts.js';

const num = (v) => Number(v || 0);
const monthOf = (iso) => String(iso || '').slice(0, 7);

/**
 * 카드 누적 대조.
 *
 * 누적은 결제일이 아니라 **달력 월** 기준이다. 그래서 그 달 1일부터 앵커가
 * 찍힌 시각까지 그 카드로 쓴 걸 더해 견준다.
 *
 * 취소된 건은 카드사 누적에서도 빠지므로 우리도 뺀다. 할부·일시불은 둘 다
 * 승인 금액이 누적에 들어가므로 구분하지 않는다.
 */
export function cardCheck(data = {}) {
  const { anchors = [], transactions = [], accounts = [] } = data;

  // 누적은 카드 한 장이 아니라 **청구서 한 장** 기준이다. 현대카드는 카드가
  // 둘이어도 합쳐 찍으므로, 묶인 카드를 다 더해야 맞는다.
  const cardOf = (a) => accounts.find((x) => x.name === a.cardName)
    || accounts.find((x) => alive(x) && isCard(x) && x.issuer === a.issuer);

  const latest = new Map();
  for (const a of anchors) {
    if (a.kind !== 'cumulative' || a.reported == null) continue;
    const card = cardOf(a);
    const key = card ? (card.statementGroupId || card.id) : (a.cardName || a.issuer || '');
    if (!key) continue;
    const cur = latest.get(key);
    if (!cur || String(a.at) > String(cur.anchor.at)) latest.set(key, { anchor: a, card });
  }

  const out = [];
  for (const [key, { anchor, card }] of latest) {
    const account = card || null;
    const group = account ? cardGroup(account, accounts) : [];
    const month = monthOf(anchor.at);

    const counted = transactions
      .filter((t) => t.type === 'expense' && t.status !== 'voided')
      .filter((t) => monthOf(t.occurredAt) === month)
      .filter((t) => String(t.occurredAt) <= String(anchor.at))
      .filter((t) => (group.length
        ? inCards(t, group)
        : (anchor.cardName && t.cardName === anchor.cardName)))
      .reduce((s, t) => s + num(t.amount), 0);

    const reported = num(anchor.reported);
    const gap = reported - counted;
    out.push({
      key, month, at: anchor.at,
      accountId: account?.id || '',
      accountIds: group.map((c) => c.id),
      name: group.length > 1 ? group.map((c) => c.name).join(' + ') : (account?.name || anchor.cardName || key),
      reported, counted, gap,
      // 1원까지 맞기를 기대하지 않는다. 앵커보다 늦게 들어온 문자가 섞일 수 있다.
      missing: gap > 0 ? gap : 0,
      extra: gap < 0 ? -gap : 0,
      ok: Math.abs(gap) < 1,
    });
  }

  return out.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
}

/**
 * 통장 잔액.
 *
 * 잔액은 누적과 달리 우리가 계산으로 맞출 수 있는 게 아니다 — 시작 잔액을
 * 모르니까. 대신 문자에 찍힌 게 곧 정답이라 그대로 가져다 쓰면 된다.
 * 계좌에 적힌 값이 문자보다 오래됐으면 갈아 끼우라고 알려 준다.
 */
export function balanceCheck(data = {}) {
  const { anchors = [], accounts = [] } = data;

  const latest = new Map();
  for (const a of anchors) {
    if (a.kind !== 'balance' || a.reported == null) continue;
    const key = a.issuer || a.cardName || '';
    if (!key) continue;
    const cur = latest.get(key);
    if (!cur || String(a.at) > String(cur.at)) latest.set(key, a);
  }

  const out = [];
  for (const [key, anchor] of latest) {
    const account = accounts.find((x) => x.issuer === key)
      || accounts.find((x) => x.name === key)
      || accounts.find((x) => x.name?.includes(key));
    if (!account) continue;

    const reported = num(anchor.reported);
    const held = num(account.balance);
    out.push({
      key, at: anchor.at,
      accountId: account.id, name: account.name,
      reported, held, gap: reported - held,
      // 문자가 계좌에 적힌 것보다 새것일 때만 갈아 끼울 값이 있다
      stale: !account.balanceAt || String(account.balanceAt) < String(anchor.at),
      ok: Math.abs(reported - held) < 1,
    });
  }

  return out.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
}
