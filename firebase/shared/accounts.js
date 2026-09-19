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
export const isCard = (a) => a?.type === 'card';

/** 신용으로 긁히는 카드만 청구가 생긴다. 체크는 그 자리에서 빠진다. */
export const billsLater = (a) => isCard(a) && a.cardType !== 'debit';

/**
 * 이번에 낼 카드값이 걸린 기간.
 *
 * 현대카드 결제일 10일 기준: 지난 10일 다음날부터 오는 10일까지 쓴 것을 낸다.
 *
 * 기간의 경계는 달력의 10일에 둔다. 명세서는 그날 닫히기 때문이다.
 * 돈이 실제로 빠지는 날만 영업일로 미룬다 — 10일이 토요일이면 12일 월요일에
 * 빠진다. 둘을 같이 밀면 11일에 쓴 게 이미 닫힌 명세서로 들어가 버린다.
 */
export function billingWindow(billingDay, now = new Date(), holidays = []) {
  const day = Math.min(31, Math.max(1, Number(billingDay) || 1));
  const y = now.getFullYear();
  const m = now.getMonth();

  // 이 달의 결제일이 아직 안 왔으면 지난달 결제일이 기준점이다.
  const thisMonth = new Date(y, m, day, 23, 59, 59, 999);
  const closed = now <= thisMonth ? new Date(y, m - 1, day, 23, 59, 59, 999) : thisMonth;
  const due = new Date(closed.getFullYear(), closed.getMonth() + 1, day, 23, 59, 59, 999);
  const payAt = nextBusinessDay(new Date(due.getFullYear(), due.getMonth(), due.getDate()), holidays);
  return { from: closed, due, payAt };
}

/**
 * 카드별로 다음 결제일에 낼 금액.
 *
 * 리볼빙으로 넘어온 금액은 그 카드에 묶인 빚에서 가져온다. 이번 달에 긁은 것만
 * 보여 주면 "이번에 얼마 나가지?"의 답이 아니다.
 */
export function cardBills(accounts = [], transactions = [], now = new Date(), holidays = []) {
  return accounts
    .filter((a) => alive(a) && billsLater(a))
    .map((card) => {
      const { from, due, payAt } = billingWindow(card.billingDay, now, holidays);
      const spent = transactions
        .filter((t) => t.status !== 'voided' && t.type === 'expense')
        .filter((t) => (t.accountId ? t.accountId === card.id : t.cardName === card.name))
        .filter((t) => {
          const at = new Date(t.occurredAt);
          return at > from && at <= due;
        })
        .reduce((sum, t) => sum + num(t.amount), 0);

      const carried = accounts
        .filter((a) => alive(a) && a.type === 'loan' && a.linkedAccountId === card.id)
        .reduce((sum, a) => sum + num(a.balance), 0);

      return {
        id: card.id, name: card.name, cardType: card.cardType || 'credit',
        billingDay: Number(card.billingDay) || null,
        from, due, payAt,
        // 10일이 토요일이면 12일에 빠진다. 미뤄진 날짜를 말해 줘야 통장을 맞출 수 있다.
        shifted: payAt.getDate() !== due.getDate(),
        spent, carried, total: spent + carried,
        daysLeft: Math.max(0, Math.ceil((payAt - now) / 86400000)),
        payFromId: card.payFromId || '',
      };
    })
    .sort((a, b) => b.total - a.total);
}

/** 가진 돈 · 빚 · 카드를 한 번에 센다. */
export function rollup(accounts = [], transactions = [], now = new Date(), holidays = []) {
  const live = accounts.filter(alive);
  const cash = live.filter((a) => cashOf(a) > 0 || ['checking', 'savings', 'cash'].includes(a.type))
    .map((a) => ({ ...a, amount: cashOf(a) }))
    .filter((a) => a.amount > 0 || a.type !== 'checking' || num(a.balance) === 0)
    .sort((a, b) => b.amount - a.amount);

  const debts = live.filter(isDebt)
    .map((a) => ({ ...a, amount: debtOf(a), rate: num(a.rate) }))
    .sort((a, b) => b.rate - a.rate || b.amount - a.amount);   // 비싼 빚부터

  const bills = cardBills(live, transactions, now, holidays);

  return {
    cash, cashTotal: cash.reduce((s, a) => s + a.amount, 0),
    debts, debtTotal: debts.reduce((s, a) => s + a.amount, 0),
    bills, billTotal: bills.reduce((s, b) => s + b.total, 0),
  };
}
