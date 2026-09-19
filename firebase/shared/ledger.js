/**
 * 화면에 뿌릴 숫자를 계산한다. 읽기만 하고 아무것도 고치지 않는다.
 *
 * 계획과 실제를 나눈다.
 *   계획 — 월 실수령, 등록한 고정지출, 잡아 둔 변동 예산.
 *          데이터가 없어도 오늘 바로 나온다. "이 속도면 몇 달"이 여기서 나온다.
 *   실제 — 이번 달에 실제로 찍힌 거래. 쌓일수록 정확해진다.
 *          "오늘 쓸 수 있는 돈"이 여기서 나온다.
 *
 * 둘을 섞지 않는 게 중요하다. 섞으면 고정지출이 두 번 세어진다 —
 * 구독은 등록해 둔 항목이기도 하고 카드 승인 문자로도 들어오기 때문이다.
 */
import { normalizeMerchant } from './parse.js';
import { netAmount } from './settlement.js';

export function monthWindow(yyyymm, cycleStartDay = 1) {
  const [year, month] = String(yyyymm).split('-').map(Number);
  const day = Number(cycleStartDay) || 1;
  return {
    start: new Date(year, month - 1, day),
    end: new Date(year, month, day),
  };
}

const inWindow = (iso, win) => {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= win.start.getTime() && t < win.end.getTime();
};

/** 거래가 등록해 둔 고정지출 중 하나인지 본다. 이름이 가맹점에 들어 있으면 같은 것으로 본다. */
export function matchRecurring(txn, recurring = []) {
  const merchant = normalizeMerchant(txn.merchantRaw);
  if (!merchant) return null;
  return recurring.find((r) => {
    const name = normalizeMerchant(r.name);
    return name && merchant.includes(name);
  }) ?? null;
}

/**
 * @param {object} data  { transactions, recurring, settlements, accounts, debts, raw, settings }
 * @param {string} yyyymm
 * @param {Date}   now    테스트에서 시점을 고정하기 위해 받는다
 */
export function ledger(data = {}, yyyymm, now = new Date()) {
  const {
    transactions = [], recurring = [], settlements = [],
    accounts = [], debts = [], raw = [], settings = {},
  } = data;

  const month = yyyymm || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const win = monthWindow(month, settings.cycleStartDay);

  // ── 실제 ────────────────────────────────────────────────
  let actualIncome = 0;
  let actualFixed = 0;
  let actualVariable = 0;
  const byCategory = {};

  for (const t of transactions) {
    if (t.status === 'voided') continue;
    if (!inWindow(t.occurredAt, win)) continue;
    if (t.type === 'transfer') continue;          // 카드대금·저축은 지출이 아니다
    if (t.excludeFromBudget) continue;

    if (t.type === 'income') { actualIncome += Number(t.amount || 0); continue; }

    const net = netAmount(t, settlements);        // 돌려받은 만큼은 내 돈이 아니다
    if (net <= 0) continue;

    if (matchRecurring(t, recurring)) actualFixed += net;
    else actualVariable += net;

    const key = t.categoryId || 'cat_unknown';
    byCategory[key] = (byCategory[key] || 0) + net;
  }

  // ── 계획 ────────────────────────────────────────────────
  const plannedIncome = Number(settings.monthlyIncome || 0);
  const plannedFixed = recurring.reduce((sum, r) => sum + Number(r.expectedAmount || 0), 0);
  const variableBudget = Number(settings.variableBudget || 0);
  const available = plannedIncome - plannedFixed - variableBudget;

  // ── 변동 예산 ───────────────────────────────────────────
  const daysLeft = Math.max(0, Math.round((win.end - now) / 86400000));
  const remaining = Math.max(0, variableBudget - actualVariable);

  // ── 빚 ─────────────────────────────────────────────────
  const openDebts = debts
    .filter((d) => Number(d.balance || 0) > 0)
    .sort((a, b) => Number(b.rate || 0) - Number(a.rate || 0));   // 비싼 빚부터

  const debtTotal = openDebts.reduce((sum, d) => sum + Number(d.balance || 0), 0);
  const startAmount = Number(settings.debtStartAmount || 0) || debtTotal;
  const paid = Math.max(0, startAmount - debtTotal);

  const target = settings.debtTargetDate ? new Date(settings.debtTargetDate) : null;
  const daysToTarget = target ? Math.round((target - now) / 86400000) : null;
  const monthsToTarget = daysToTarget === null ? null : daysToTarget / 30.44;
  const needPerMonth = (monthsToTarget && monthsToTarget > 0)
    ? Math.round(debtTotal / monthsToTarget) : null;
  // 여력이 없으면 몇 달 걸리는지 답하지 않는다. 무한대를 보여 주는 건 답이 아니다.
  const paceMonths = available > 0 ? Math.round((debtTotal / available) * 10) / 10 : null;

  // ── 가진 돈 ─────────────────────────────────────────────
  // 카드는 자산이 아니라 아직 안 낸 돈이므로 세지 않는다.
  const assets = accounts
    .filter((a) => a.type !== 'card' && a.active !== false)
    .map((a) => ({ id: a.id, name: a.name, type: a.type,
                   balance: Number(a.balance || 0), balanceAt: a.balanceAt }))
    .sort((a, b) => b.balance - a.balance);
  const assetTotal = assets.reduce((sum, a) => sum + a.balance, 0);

  return {
    month,
    planned: { income: plannedIncome, fixed: plannedFixed, variableBudget, available },
    actual: { income: actualIncome, fixed: actualFixed, variable: actualVariable, byCategory },
    budget: {
      limit: variableBudget,
      spent: actualVariable,
      remaining,
      daysLeft,
      perDay: daysLeft > 0 ? Math.floor(remaining / daysLeft) : remaining,
      usedPct: variableBudget > 0 ? Math.round((actualVariable / variableBudget) * 100) : 0,
    },
    debt: {
      items: openDebts,
      total: debtTotal,
      startAmount,
      paid,
      progressPct: startAmount > 0 ? Math.round((paid / startAmount) * 100) : 0,
      targetDate: settings.debtTargetDate || '',
      daysToTarget,
      needPerMonth,
      paceMonths,
      shortfall: needPerMonth === null ? null : Math.max(0, needPerMonth - available),
      onTrack: needPerMonth === null ? null : available >= needPerMonth,
    },
    assets: { items: assets, total: assetTotal, net: assetTotal - debtTotal },
    inbox: {
      pending: transactions.filter((t) => t.status === 'pendingCategory').length,
      unparsed: raw.filter((r) => !r.parsedOk && !r.txnId).length,
    },
  };
}
