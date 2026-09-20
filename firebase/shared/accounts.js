/**
 * 계좌 · 카드 · 빚을 한 곳에서 다룬다.
 *
 * 따로 두니 마이너스통장을 어디에 넣을지 애매했다. 마이너스통장은 입출금
 * 계좌이면서 동시에 빚이다 — 잔액이 음수로 내려가고 거기에 이자가 붙는다.
 * 그래서 넣는 곳은 하나로 두고, 보는 곳에서만 가진 돈과 빚으로 가른다.
 *
 *   checking  입출금. 잔액이 음수면 마이너스통장이고 그 절댓값이 빚이다.
 *   savings   저축 · 투자
 *   cash      현금
 *   card      카드. 잔액을 쓰지 않는다 — 얼마 나갈지는 거래에서 센다.
 *   loan      리볼빙 · 대출. 잔액은 갚아야 할 금액이라 양수다.
 *
 * 카드 미결제액은 빚으로 세지 않는다. 매달 쓰고 매달 내는 돈을 빚 목록에
 * 올리면 정작 갚아야 할 것이 묻힌다. 리볼빙으로 넘어간 것만 빚이다.
 */

import { nextBusinessDay } from './holidays.js';

export const ACCOUNT_TYPES = ['checking', 'savings', 'cash', 'card', 'loan'];
export const CARD_TYPES = ['credit', 'debit', 'hybrid'];

export const TYPE_LABEL = {
  checking: '입출금', savings: '저축 · 투자', cash: '현금',
  card: '카드', loan: '빚 (리볼빙 · 대출)',
};
export const CARD_LABEL = { credit: '신용', debit: '체크', hybrid: '체크 + 신용' };

const num = (v) => Number(v || 0);
export const alive = (a) => a && a.active !== false;

/** 이 계좌가 품고 있는 빚. 없으면 0. */
export function debtOf(account) {
  if (!alive(account)) return 0;
  if (account.type === 'loan') return Math.max(0, num(account.balance));
  if (account.type === 'checking') return Math.max(0, -num(account.balance));
  // 리볼빙으로 넘어간 것만 빚이다. 매달 쓰고 매달 내는 카드값은 아니다.
  if (account.type === 'card') return revolvingOf(account);
  return 0;
}

/** 이 계좌에 든 내 돈. 마이너스통장이 음수일 때 0 이지 음수가 아니다. */
export function cashOf(account) {
  if (!alive(account)) return 0;
  if (account.type === 'savings' || account.type === 'cash') return num(account.balance);
  if (account.type === 'checking') return Math.max(0, num(account.balance));
  return 0;
}

export const isDebt = (a) => debtOf(a) > 0 || a?.type === 'loan';

/** 마이너스통장은 플러스일 때와 마이너스일 때 이자율이 다르다. */
export const rateOf = (a) => (num(a?.balance) < 0 || a?.type === 'loan'
  ? num(a?.rate)                       // 물어야 하는 이자
  : num(a?.ratePlus));                 // 받는 이자
export const isCard = (a) => a?.type === 'card';

/** 신용으로 긁히는 카드만 청구가 생긴다. 체크는 그 자리에서 빠진다. */
export const billsLater = (a) => isCard(a) && a.cardType !== 'debit';

/**
 * 이번에 낼 카드값이 걸린 기간.
 *
 * 현대카드는 결제일이 10일이어도 청구 대상은 "지난 10일부터"가 아니라
 * **지난달 1일부터 말일까지** 쓴 것이다. 10월 10일에 내는 건 9월 한 달치다.
 *
 * 그래서 기간은 달력 월로 잡고, 그 달의 다음 달 10일에 낸다.
 * 돈이 실제로 빠지는 날만 영업일로 미룬다 — 10일이 토요일이면 12일 월요일.
 */
export function billingWindow(billingDay, now = new Date(), holidays = []) {
  const day = Math.min(31, Math.max(1, Number(billingDay) || 1));
  const y = now.getFullYear();
  const m = now.getMonth();

  // 이 달 결제일이 아직 안 왔으면 이번 결제가 다음 차례다.
  const dueThisMonth = new Date(y, m, day, 23, 59, 59, 999);
  const dueMonth = now <= dueThisMonth ? m : m + 1;

  // 청구 대상은 내는 달의 **한 달 전** 달력 월 전체다.
  const from = new Date(y, dueMonth - 1, 1, 0, 0, 0, 0);
  const to = new Date(y, dueMonth, 0, 23, 59, 59, 999);
  const due = new Date(y, dueMonth, day, 23, 59, 59, 999);
  const payAt = nextBusinessDay(new Date(due.getFullYear(), due.getMonth(), due.getDate()), holidays);

  return {
    from, to, due, payAt,
    // 그 달이 아직 안 끝났으면 청구액이 계속 는다
    open: now <= to,
    month: `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}`,
  };
}

/**
 * 같은 청구서를 쓰는 카드끼리 묶는다.
 *
 * 현대카드는 카드가 둘이어도 누적을 **합쳐서** 찍는다. 미래에셋에서 10만,
 * 이마트에서 5만 쓰고 미래에셋으로 1만을 더 쓰면 "현대 미래에셋 1만 /
 * 누적 26만"이다. 카드 하나로만 견주면 영영 안 맞는다.
 *
 * 체크카드와 통장도 같은 문제다 — 통장에서 바로 빠지는데 따로 세면 두 몫이 된다.
 */
export const groupKeyOf = (a) => a?.statementGroupId || a?.id || '';

/** 이 카드와 청구서를 함께 쓰는 카드들. 자기 자신을 포함한다. */
export function cardGroup(account, accounts = []) {
  if (!account) return [];
  const key = groupKeyOf(account);
  const group = accounts.filter((a) => alive(a) && isCard(a) && groupKeyOf(a) === key);
  return group.length ? group : [account];
}

const flat = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '');

/**
 * 문자에 찍힌 카드 이름을 등록한 카드에 붙인다.
 *
 * 문자에는 "현대 미래에셋 승인"처럼 찍히는데 파서는 발급사를 떼고 "미래에셋"만
 * 남긴다. 등록한 이름은 "현대 미래에셋"이라 글자가 딱 맞지 않는다. 한쪽이
 * 다른 쪽을 품고 있으면 같은 카드로 본다.
 *
 * 둘 이상에 걸리면 아무것도 고르지 않는다. 엉뚱한 카드에 붙이면 청구액이
 * 조용히 틀리고, 틀린 줄도 모른다.
 */
export function matchCard(cardName, accounts = []) {
  const key = flat(cardName);
  if (!key) return null;
  const cards = accounts.filter((a) => alive(a) && isCard(a));

  const exact = cards.filter((c) => flat(c.name) === key);
  if (exact.length === 1) return exact[0];

  const loose = cards.filter((c) => {
    const n = flat(c.name);
    return n && (n.includes(key) || key.includes(n));
  });
  return loose.length === 1 ? loose[0] : null;
}

/** 그 거래가 이 카드들 중 하나로 긁힌 것인가. */
export function inCards(t, cards = []) {
  if (t.accountId) return cards.some((c) => c.id === t.accountId);
  if (!t.cardName) return false;
  // accountId 가 안 붙은 옛 거래는 이름으로 찾는다
  const hit = matchCard(t.cardName, cards);
  return Boolean(hit) && cards.some((c) => c.id === hit.id);
}

/**
 * 리볼빙.
 *
 * 리볼빙은 따로 빌린 돈이 아니라 **카드의 성질**이다. 카드사 앱에서 "이번 달
 * 결제액의 몇 %를 낼지"를 정해 두면, 나머지에 이자가 붙어 다음 달 결제액에
 * 합쳐진다.
 *
 *   청구 대상 = 지난달 사용액 + 넘어온 이월잔액
 *   이번에 낼 돈 = 청구 대상 × 약정비율
 *   다음 달로 = 나머지 (거기에 이자가 붙는다)
 *
 * 이월잔액은 카드사가 정하는 숫자라 앱이 셀 수 없다. 카드 앱에서 보고 넣는다.
 */
export const revolvingOf = (a) => (a?.revolving ? Math.max(0, num(a.revolvingBalance)) : 0);

/**
 * 카드별로 다음 결제일에 낼 금액.
 *
 * 묶인 카드는 한 줄로 합쳐 낸다 — 청구서가 하나니까.
 */
export function cardBills(accounts = [], transactions = [], now = new Date(), holidays = []) {
  const cards = accounts.filter((a) => alive(a) && billsLater(a));
  const seen = new Set();
  const out = [];

  for (const card of cards) {
    const key = groupKeyOf(card);
    if (seen.has(key)) continue;
    seen.add(key);

    const group = cardGroup(card, accounts);
    const lead = group.find((c) => c.billingDay) || card;
    const w = billingWindow(lead.billingDay, now, holidays);

    const usage = transactions
      .filter((t) => t.status !== 'voided' && t.type === 'expense')
      .filter((t) => inCards(t, group))
      .filter((t) => {
        const at = new Date(t.occurredAt);
        return at >= w.from && at <= w.to;
      })
      .reduce((sum, t) => sum + num(t.amount), 0);

    const carried = group.reduce((s, c) => s + revolvingOf(c), 0);
    const billed = usage + carried;

    // 약정비율은 묶음에서 가장 낮은 것을 쓴다 — 리볼빙을 건 카드가 하나라도
    // 있으면 그 비율이 청구서 전체에 걸린다.
    const ratios = group.filter((c) => c.revolving)
      .map((c) => Math.min(100, Math.max(1, num(c.revolvingRatio) || 100)));
    const ratio = ratios.length ? Math.min(...ratios) : 100;
    const payNow = Math.round(billed * (ratio / 100));
    const carryOut = Math.max(0, billed - payNow);
    const rate = Math.max(0, ...group.map((c) => num(c.revolvingRate)));

    out.push({
      id: key,
      ids: group.map((c) => c.id),
      name: group.length > 1 ? group.map((c) => c.name).join(' + ') : card.name,
      names: group.map((c) => c.name),
      cardType: card.cardType || 'credit',
      billingDay: Number(lead.billingDay) || null,
      from: w.from, to: w.to, due: w.due, payAt: w.payAt, month: w.month, open: w.open,
      shifted: w.payAt.getDate() !== w.due.getDate(),
      usage, carried, billed,
      revolving: ratio < 100,
      ratio,
      total: payNow,
      carryOut,
      // 이월분에 다음 달 붙을 이자. 대략이라도 보여야 리볼빙이 얼마나 비싼지 안다.
      interest: rate > 0 ? Math.round((carryOut * (rate / 100)) / 12) : 0,
      daysLeft: Math.max(0, Math.ceil((w.payAt - now) / 86400000)),
      payFromId: lead.payFromId || '',
    });
  }

  return out.sort((a, b) => b.total - a.total);
}

/** 가진 돈 · 빚 · 카드를 한 번에 센다. */
export function rollup(accounts = [], transactions = [], now = new Date(), holidays = []) {
  const live = accounts.filter(alive);
  const cash = live.filter((a) => cashOf(a) > 0 || ['checking', 'savings', 'cash'].includes(a.type))
    .map((a) => ({ ...a, amount: cashOf(a) }))
    .filter((a) => a.amount > 0 || a.type !== 'checking' || num(a.balance) === 0)
    .sort((a, b) => b.amount - a.amount);

  const debts = live.filter(isDebt)
    .map((a) => ({ ...a, amount: debtOf(a),
                   rate: a.type === 'card' ? num(a.revolvingRate) : num(a.rate) }))
    .sort((a, b) => b.rate - a.rate || b.amount - a.amount);   // 비싼 빚부터

  const bills = cardBills(live, transactions, now, holidays);

  return {
    cash, cashTotal: cash.reduce((s, a) => s + a.amount, 0),
    debts, debtTotal: debts.reduce((s, a) => s + a.amount, 0),
    bills, billTotal: bills.reduce((s, b) => s + b.total, 0),
  };
}
