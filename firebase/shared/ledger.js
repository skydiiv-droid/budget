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
import { hitsRecurring, liveRecurring } from './fixed.js';
import { netAmount } from './settlement.js';
import { rollup } from './accounts.js';
import { prevBusinessDay } from './holidays.js';

/**
 * 한 주기의 처음과 끝.
 *
 * 주기를 급여일에 맞추면 "쓸 수 있는 돈"이 지갑 현실과 맞는다. 급여일이
 * 쉬는 날이면 돈은 **앞당겨** 들어오므로 주기도 그날부터 시작해야 한다.
 * 5일이 일요일이면 3일 금요일에 들어오고, 주기도 3일부터다.
 *
 * 1일 시작이면 달력 월이라 옮길 것이 없다. 통계와 비교는 이쪽을 쓴다 —
 * 경계가 해마다 흔들리면 지난달과 견줄 수가 없다.
 */
/**
 * 한 달에 나가는 고정비.
 *
 * 연 1회짜리(자동차보험 · 연회비)는 열두 달로 나눠 얹는다. 나가는 달에만
 * 세면 그달만 갑자기 여력이 없어 보이고 나머지 열한 달은 있는 줄 안다.
 */
export function monthlyFixed(recurring = []) {
  // 해지한 것은 더 안 나간다. 여력에서 빼야 맞는다.
  return liveRecurring(recurring).reduce((sum, r) => {
    const amount = Number(r.expectedAmount || 0);
    return sum + (r.period === 'yearly' ? amount / 12 : amount);
  }, 0);
}

/** 이 달에 실제로 빠져나갈 고정비. 연 1회짜리는 그달에만. */
export function fixedDueIn(recurring = [], yyyymm) {
  const month = Number(String(yyyymm).split('-')[1]);
  return liveRecurring(recurring)
    .filter((r) => r.period !== 'yearly' || Number(r.monthOfYear) === month);
}

export function monthWindow(yyyymm, cycleStartDay = 1, opts = {}) {
  const [year, month] = String(yyyymm).split('-').map(Number);
  const day = Number(cycleStartDay) || 1;
  const start = new Date(year, month - 1, day);
  const end = new Date(year, month, day);
  if (!opts.payday || day === 1) return { start, end };
  const extra = opts.holidays || [];
  return { start: prevBusinessDay(start, extra), end: prevBusinessDay(end, extra) };
}

const inWindow = (iso, win) => {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= win.start.getTime() && t < win.end.getTime();
};

/**
 * 거래가 등록해 둔 고정지출 중 하나인지 본다.
 *
 * 이름·키워드·결제 수단으로 가른다. 판단은 한 곳(fixed.js)에만 두어야
 * 고정비 화면이 "들어왔다"고 하는데 여기서는 변동비로 세는 일이 없다.
 */
export function matchRecurring(txn, recurring = [], accounts = []) {
  return recurring.find((r) => hitsRecurring(txn, r, accounts)) ?? null;
}

/**
 * @param {object} data  { transactions, recurring, settlements, accounts, categories, raw, settings }
 * @param {string} yyyymm
 * @param {Date}   now    테스트에서 시점을 고정하기 위해 받는다
 */
export function ledger(data = {}, yyyymm, now = new Date()) {
  const {
    transactions = [], recurring = [], settlements = [],
    accounts = [], categories = [], raw = [], settings = {},
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

    if (matchRecurring(t, recurring, accounts)) actualFixed += net;
    else actualVariable += net;

    const key = t.categoryId || 'cat_unknown';
    byCategory[key] = (byCategory[key] || 0) + net;
  }

  // ── 계획 ────────────────────────────────────────────────
  const plannedIncome = Number(settings.monthlyIncome || 0);
  const plannedFixed = monthlyFixed(recurring);
  const variableBudget = Number(settings.variableBudget || 0);
  const available = plannedIncome - plannedFixed - variableBudget;

  // ── 변동 예산 ───────────────────────────────────────────
  const daysLeft = Math.max(0, Math.round((win.end - now) / 86400000));
  const remaining = Math.max(0, variableBudget - actualVariable);

  // ── 빚 · 가진 돈 · 카드 ─────────────────────────────────
  // 마이너스통장은 입출금 계좌이면서 빚이다. 한 곳에서 갈라야 양쪽에 겹치지 않는다.
  const roll = rollup(accounts, transactions, now, settings.extraHolidays || []);
  const openDebts = roll.debts;
  const debtTotal = roll.debtTotal;
  const startAmount = Number(settings.debtStartAmount || 0) || debtTotal;
  const paid = Math.max(0, startAmount - debtTotal);

  const target = settings.debtTargetDate ? new Date(settings.debtTargetDate) : null;
  const daysToTarget = target ? Math.round((target - now) / 86400000) : null;
  const monthsToTarget = daysToTarget === null ? null : daysToTarget / 30.44;
  const needPerMonth = (monthsToTarget && monthsToTarget > 0)
    ? Math.round(debtTotal / monthsToTarget) : null;
  // 여력이 없으면 몇 달 걸리는지 답하지 않는다. 무한대를 보여 주는 건 답이 아니다.
  const paceMonths = available > 0 ? Math.round((debtTotal / available) * 10) / 10 : null;

  const assets = roll.cash.map((a) => ({ id: a.id, name: a.name, type: a.type,
                                        balance: a.amount, balanceAt: a.balanceAt }));
  const assetTotal = roll.cashTotal;

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
    goal: goalProgress(settings, { debtTotal, assetTotal, available }, now),
    byCategory: categoryBudgets(byCategory, settings, categories),
    cards: { items: roll.bills, total: roll.billTotal },
    inbox: {
      pending: transactions.filter((t) => t.status === 'pendingCategory').length,
      unparsed: raw.filter((r) => !r.parsedOk && !r.txnId).length,
    },
  };
}

// ───────────────────────────────────────────────── 내역

export const monthKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

export function shiftMonth(yyyymm, delta) {
  const [y, m] = String(yyyymm).split('-').map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1));
}

/**
 * 그 달에 쓴 돈. 최근 것부터.
 *
 * 합계와 목록이 어긋나면 안 되므로 ledger 와 같은 잣대를 쓴다. 예산에서 뺀 건과
 * 정산으로 다 돌려받은 건은 목록에는 남기되 세지 않는다 — 안 보이면 왜 합계가
 * 다른지 알 길이 없다.
 */
export function monthSpending(data = {}, yyyymm, now = new Date()) {
  const { transactions = [], settlements = [], settings = {} } = data;
  const win = monthWindow(yyyymm || monthKey(now), settings.cycleStartDay);

  return transactions
    .filter((t) => t.status !== 'voided' && t.type === 'expense' && inWindow(t.occurredAt, win))
    .map((t) => {
      const net = netAmount(t, settlements);
      return { ...t, net, counted: !t.excludeFromBudget && net > 0 };
    })
    .sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)));
}

/**
 * 큰 갈래로 접어 올린 지출.
 *
 * 카테고리를 두 단계로 나눈 이유가 여기서 드러난다. 스무 칸을 늘어놓으면
 * 어디에 새는지 안 보이지만, 큰 갈래 열 개면 한눈에 보인다. 자세히 볼 갈래만
 * 펼치면 된다.
 */
const bySpend = (a, b) => (b.amount - a.amount) || String(a.id).localeCompare(String(b.id));

export function breakdown(rows = [], categories = []) {
  const find = (id) => categories.find((c) => c.id === id) || null;
  const mains = new Map();
  let total = 0;

  for (const r of rows) {
    if (!r.counted) continue;
    const c = find(r.categoryId);
    const mainId = c ? (c.parentId || c.id) : (r.categoryId || 'cat_unknown');

    const m = mains.get(mainId) || { id: mainId, amount: 0, count: 0, subs: new Map() };
    m.amount += r.net;
    m.count += 1;

    if (c?.parentId) {
      const s = m.subs.get(c.id) || { id: c.id, amount: 0, count: 0 };
      s.amount += r.net;
      s.count += 1;
      m.subs.set(c.id, s);
    }
    mains.set(mainId, m);
    total += r.net;
  }

  const items = [...mains.values()]
    .map((m) => ({
      id: m.id,
      amount: m.amount,
      count: m.count,
      pct: total > 0 ? Math.round((m.amount / total) * 100) : 0,
      subs: [...m.subs.values()].sort(bySpend),
    }))
    .sort(bySpend);

  return { total, items };
}

/**
 * 지난달 같은 기간. 달 전체와 견주면 달 초엔 늘 "덜 썼다"가 되고 말일에 뒤집힌다.
 * 9월 19일까지 쓴 돈은 8월 19일까지 쓴 돈과 견줘야 말이 된다.
 */
export function sameSpanLastMonth(data = {}, yyyymm, now = new Date()) {
  const { settings = {} } = data;
  const month = yyyymm || monthKey(now);
  const win = monthWindow(month, settings.cycleStartDay);
  const elapsed = Math.max(0, Math.min(now.getTime(), win.end.getTime()) - win.start.getTime());

  const prev = shiftMonth(month, -1);
  const prevWin = monthWindow(prev, settings.cycleStartDay);
  // 이 달이 이미 끝났으면 지난달도 통째로 본다. 달마다 날 수가 달라
  // 흘러간 시간을 그대로 옮기면 31일 달에서 하루가 잘린다.
  const done = now.getTime() >= win.end.getTime();
  const cut = done ? prevWin.end
    : new Date(Math.min(prevWin.start.getTime() + elapsed, prevWin.end.getTime()));

  const rows = monthSpending(data, prev, now)
    .filter((r) => new Date(r.occurredAt).getTime() < cut.getTime());

  return {
    month: prev,
    until: cut,
    rows,
    total: rows.reduce((sum, r) => sum + (r.counted ? r.net : 0), 0),
    whole: done,
  };
}

/**
 * 이 속도로 가면 이 달은 얼마가 되나.
 *
 * "12% 더 씀"은 남은 날에 뭘 해야 하는지를 말해 주지 않는다. 끝값을 알아야
 * 지금 줄일지 말지가 정해진다.
 */
export function pace(spentSoFar, yyyymm, cycleStartDay, now = new Date()) {
  const win = monthWindow(yyyymm || monthKey(now), cycleStartDay);
  const whole = win.end - win.start;
  const gone = Math.min(Math.max(now - win.start, 0), whole);
  if (gone <= 0) return { projected: 0, dayOf: 0, days: Math.round(whole / 86400000) };
  return {
    projected: Math.round(Number(spentSoFar || 0) * (whole / gone)),
    dayOf: Math.ceil(gone / 86400000),
    days: Math.round(whole / 86400000),
  };
}

// ───────────────────────────────────────────────── 목표

/**
 * 목표.
 *
 * 처음에는 "빚 갚기"만 있었다. 그런데 빚을 다 갚으면 홈이 텅 빈다. 갚는 것도
 * 모으는 것도 "지금 얼마이고 어디까지 가야 하는가"라는 같은 모양이라,
 * 하나로 두고 방향만 바꾼다.
 *
 *   payoff  빚을 줄인다 — 시작 금액에서 0 으로
 *   save    돈을 모은다 — 0 에서 목표 금액으로
 *   keep    목표 없이 지켜본다
 */
export function goalProgress(settings = {}, now_ = {}, now = new Date()) {
  const { debtTotal = 0, assetTotal = 0, available = 0 } = now_;

  // 빚 목표만 쓰던 시절의 설정을 그대로 읽는다
  const g = settings.goal || {
    kind: debtTotal > 0 || settings.debtStartAmount ? 'payoff' : 'keep',
    name: '빚 정리',
    startAmount: Number(settings.debtStartAmount || 0),
    targetAmount: 0,
    targetDate: settings.debtTargetDate || '',
  };

  const kind = g.kind || 'keep';
  const targetDate = g.targetDate || '';
  const daysToTarget = targetDate
    ? Math.round((new Date(targetDate) - now) / 86400000) : null;
  const monthsToTarget = daysToTarget === null ? null : daysToTarget / 30.44;

  if (kind === 'keep') {
    return { kind, name: g.name || '지켜보기', current: assetTotal - debtTotal,
             pct: null, remaining: null, daysToTarget, needPerMonth: null,
             paceMonths: null, onTrack: null, done: false };
  }

  const isPayoff = kind === 'payoff';
  const start = Number(g.startAmount || 0) || (isPayoff ? debtTotal : 0);
  const target = isPayoff ? 0 : Number(g.targetAmount || 0);
  const current = isPayoff ? debtTotal : assetTotal;

  const span = Math.abs(start - target);
  const moved = isPayoff ? Math.max(0, start - current) : Math.max(0, current - start);
  const remaining = Math.max(0, isPayoff ? current : target - current);

  const needPerMonth = (monthsToTarget && monthsToTarget > 0)
    ? Math.round(remaining / monthsToTarget) : null;
  // 여력이 없으면 몇 달 걸리는지 답하지 않는다. 무한대는 답이 아니다.
  const paceMonths = available > 0 ? Math.round((remaining / available) * 10) / 10 : null;

  return {
    kind, name: g.name || (isPayoff ? '빚 정리' : '모으기'),
    start, target, current, moved, remaining,
    pct: span > 0 ? Math.min(100, Math.round((moved / span) * 100)) : 0,
    targetDate, daysToTarget, needPerMonth, paceMonths,
    shortfall: needPerMonth === null ? null : Math.max(0, needPerMonth - available),
    onTrack: needPerMonth === null ? null : available >= needPerMonth,
    done: remaining <= 0,
  };
}

// ───────────────────────────────────────────────── 갈래별 예산 · 추이

/**
 * 갈래별 예산.
 *
 * 생활비 총액 하나만 잡으면 "넘었다"는 알아도 어디서 넘었는지는 모른다.
 * 식비 40만처럼 나눠 두면 터지는 자리가 보인다.
 *
 * 하위 칸에 쓴 돈은 큰 갈래로 접어 올린다 — 예산은 큰 갈래에만 잡는다.
 * 배달 · 외식 · 카페에 따로 예산을 잡으라고 하면 아무도 안 잡는다.
 */
export function categoryBudgets(byCategory = {}, settings = {}, categories = []) {
  const limits = settings.categoryBudgets || {};
  const mainOf = (id) => {
    const c = categories.find((x) => x.id === id);
    return c ? (c.parentId || c.id) : (id || 'cat_unknown');
  };

  const spent = {};
  for (const [id, amount] of Object.entries(byCategory)) {
    const main = mainOf(id);
    spent[main] = (spent[main] || 0) + Number(amount || 0);
  }

  const ids = new Set([...Object.keys(spent), ...Object.keys(limits)]);
  const items = [...ids].map((id) => {
    const limit = Number(limits[id] || 0);
    const used = spent[id] || 0;
    return {
      id, limit, used,
      remaining: limit ? Math.max(0, limit - used) : null,
      pct: limit ? Math.round((used / limit) * 100) : null,
      over: limit > 0 && used > limit,
    };
  }).sort((a, b) => b.used - a.used);

  return {
    items,
    withLimit: items.filter((i) => i.limit > 0),
    overCount: items.filter((i) => i.over).length,
    limitTotal: items.reduce((s, i) => s + i.limit, 0),
  };
}

/**
 * 달마다 얼마 썼나. 최근 것이 마지막에 온다 — 그래프는 왼쪽에서 오른쪽으로 읽는다.
 *
 * 이번 달은 아직 안 끝났다. 끝난 달과 나란히 두면 "이번 달은 적게 썼네"로
 * 잘못 읽히므로, 지금 속도로 갔을 때의 끝값을 따로 들려 보낸다.
 */
export function trend(data = {}, months = 6, now = new Date()) {
  const { settings = {} } = data;
  const thisMonth = monthKey(now);
  const out = [];

  for (let i = months - 1; i >= 0; i--) {
    const key = shiftMonth(thisMonth, -i);
    const rows = monthSpending(data, key, now);
    const total = rows.reduce((sum, r) => sum + (r.counted ? r.net : 0), 0);
    const current = key === thisMonth;
    out.push({
      month: key,
      label: `${Number(key.split('-')[1])}월`,
      total,
      count: rows.length,
      current,
      projected: current ? pace(total, key, settings.cycleStartDay, now).projected : total,
    });
  }
  return out;
}

/**
 * 어디에 제일 많이 썼나. 위젯처럼 몇 줄 안 들어가는 자리에 쓴다.
 *
 * 큰 갈래로 접어 올린 뒤 위에서 몇 개만 자른다. 하위까지 늘어놓으면
 * "카페 3천 · 편의점 2천"처럼 잔돈이 앞을 차지해 정작 큰 게 안 보인다.
 */
export function topSpending(rows = [], categories = [], count = 3) {
  const b = breakdown(rows, categories);
  const find = (id) => categories.find((c) => c.id === id);
  return b.items.slice(0, count).map((it) => {
    const c = find(it.id);
    return {
      id: it.id,
      name: c?.name || it.id,
      icon: c?.icon || '',
      amount: it.amount,
      pct: it.pct,
      count: it.count,
    };
  });
}
