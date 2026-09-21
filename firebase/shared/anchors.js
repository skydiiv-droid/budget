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

import { cardGroup, inCards, alive, isCard, revolvingOf } from './accounts.js';

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
 *
 * 리볼빙을 쓰면 카드사가 찍는 누적에 **지난달에서 넘어온 이월잔액**이 얹혀
 * 있다. 그건 이번 달에 긁은 게 아니라 우리 거래에는 없으므로, 빼 두지 않으면
 * 이월잔액만큼이 통째로 "문자를 놓친 결제"로 뜬다.
 */
export function cardCheck(data = {}) {
  const { anchors = [], transactions = [], accounts = [] } = data;

  // 누적은 카드 한 장이 아니라 **청구서 한 장** 기준이다. 현대카드는 카드가
  // 둘이어도 합쳐 찍으므로, 묶인 카드를 다 더해야 맞는다.
  const cardOf = (a) => accounts.find((x) => x.name === a.cardName)
    || accounts.find((x) => alive(x) && isCard(x) && x.issuer === a.issuer);

  // 묶음마다 문자를 **다 모은다.** 제일 나중 것만 보면 얼마나 벌어졌는지는
  // 알아도 **언제부터** 벌어졌는지는 모른다. 그걸 알아야 카드사 앱에서
  // 어디를 봐야 할지 안다.
  const byKey = new Map();
  for (const a of anchors) {
    if (a.kind !== 'cumulative' || a.reported == null) continue;
    const card = cardOf(a);
    const key = card ? (card.statementGroupId || card.id) : (a.cardName || a.issuer || '');
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { card, list: [] });
    byKey.get(key).list.push(a);
  }

  const latest = new Map();
  for (const [key, { card, list }] of byKey) {
    list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    latest.set(key, { anchor: list[list.length - 1], card, list });
  }

  const out = [];
  for (const [key, { anchor, card, list }] of latest) {
    const account = card || null;
    const group = account ? cardGroup(account, accounts) : [];
    const month = monthOf(anchor.at);

    const mine = transactions
      .filter((t) => t.type === 'expense' && t.status !== 'voided')
      .filter((t) => (group.length
        ? inCards(t, group)
        : (anchor.cardName && t.cardName === anchor.cardName)));

    /** 그 문자가 찍힌 시각까지 우리가 센 그달 누적. */
    const countedAt = (at) => mine
      .filter((t) => monthOf(t.occurredAt) === monthOf(at))
      .filter((t) => String(t.occurredAt) <= String(at))
      .reduce((s, t) => s + num(t.amount), 0);

    const counted = countedAt(anchor.at);
    const reported = num(anchor.reported);
    const raw = reported - counted;

    // 이월잔액을 빼 보되, 그래서 오히려 더 벌어지면 그 카드사는 누적에
    // 이월분을 안 얹는다는 뜻이다. 그때는 손대지 않는다.
    const carried = group.reduce((s, c) => s + revolvingOf(c), 0);
    const used = carried > 0 && Math.abs(raw - carried) < Math.abs(raw) ? carried : 0;
    const gap = raw - used;

    out.push({
      key, month, at: anchor.at,
      accountId: account?.id || '',
      accountIds: group.map((c) => c.id),
      name: group.length > 1 ? group.map((c) => c.name).join(' + ') : (account?.name || anchor.cardName || key),
      reported, counted, gap,
      // 어디서부터 틀어졌나. 카드사 앱에서 볼 구간을 여기로 좁힌다.
      ...breakPoint(list, countedAt, used),
      // 누적에 얹혀 있던 리볼빙 이월잔액. 0 이면 안 얹혀 있었다는 뜻이다.
      carried: used,
      // 1원까지 맞기를 기대하지 않는다. 앵커보다 늦게 들어온 문자가 섞일 수 있다.
      missing: gap > 0 ? gap : 0,
      extra: gap < 0 ? -gap : 0,
      ok: Math.abs(gap) < 1,
    });
  }

  return out.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
}

/**
 * 언제부터 어긋났나.
 *
 * "3만 2천원이 빈다"만으로는 카드사 앱에서 한 달치를 다 훑어야 한다.
 * 문자는 올 때마다 그 시점의 누적을 찍고 가므로, **맞았던 마지막 문자**와
 * **처음 틀어진 문자**를 찾으면 그 사이만 보면 된다.
 *
 *   9/17 14:20  누적 523,350  우리도 523,350   ← 여기까진 맞았다
 *   9/18 10:20  누적 556,250  우리는 523,350   ← 여기서 틀어졌다
 *   그 사이에 32,900 짜리 결제가 하나 빠졌다.
 */
function breakPoint(list = [], countedAt, carried = 0) {
  const off = (a) => num(a.reported) - countedAt(a.at) - carried;

  let ok = null;      // 맞았던 마지막 문자
  let bad = null;     // 그 뒤로 처음 틀어진 문자
  for (const a of list) {
    if (Math.abs(off(a)) < 1) { ok = a; bad = null; continue; }
    if (!bad) bad = a;
  }
  if (!bad) return { since: null, lastOk: null, window: 0 };

  return {
    // 여기서부터 틀어졌다
    since: { at: bad.at, reported: num(bad.reported), counted: countedAt(bad.at), gap: off(bad) },
    // 여기까진 맞았다. 없으면 처음부터 안 맞았다는 뜻이다.
    lastOk: ok ? { at: ok.at, reported: num(ok.reported), counted: countedAt(ok.at) } : null,
    // 사이에 낀 문자 수. 0 이면 두 문자가 바로 붙어 있다.
    window: ok ? list.filter((a) => String(a.at) > String(ok.at) && String(a.at) < String(bad.at)).length : 0,
  };
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
