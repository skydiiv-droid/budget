/**
 * 화면에 뿌릴 숫자를 계산한다. 시트를 읽기만 하고 고치지 않는다.
 *
 * 계획과 실제를 나눈다.
 *   계획 — 월 실수령, 등록한 고정지출, 잡아 둔 변동 예산.
 *          데이터가 없어도 오늘 바로 나온다. "이 속도면 몇 달" 이 여기서 나온다.
 *   실제 — 이번 달에 실제로 찍힌 거래. 쌓일수록 정확해진다.
 *          "오늘 쓸 수 있는 돈" 이 여기서 나온다.
 *
 * 둘을 섞지 않는 게 중요하다. 섞으면 고정지출이 두 번 세어진다 —
 * 구독은 등록해 둔 항목이기도 하고 카드 승인 문자로도 들어오기 때문이다.
 */

function setting_(key, fallback) {
  const row = findBy_('Settings', 'key', key);
  if (!row || row.value === '' || row.value === null || row.value === undefined) return fallback;
  const n = Number(row.value);
  return isNaN(n) ? row.value : n;
}

function putSetting_(key, value) {
  const row = findBy_('Settings', 'key', key);
  if (row) update_('Settings', key, { value: value }) || updateByKey_(key, value);
  else append_('Settings', { key: key, value: value });
}

/** Settings는 id가 아니라 key로 찾으므로 update_ 를 쓸 수 없다. */
function updateByKey_(key, value) {
  const sheet = sheet_('Settings');
  const values = sheet.getDataRange().getValues();
  for (let r = 1; r < values.length; r++) {
    if (values[r][0] === key) { sheet.getRange(r + 1, 2).setValue(value); return true; }
  }
  return false;
}

/** 'yyyy-MM' 이 가리키는 사이클의 시작과 끝(다음 시작 직전). */
function monthWindow_(yyyymm) {
  const startDay = Number(setting_('cycleStartDay', CONFIG.cycleStartDay)) || 1;
  const parts = String(yyyymm).split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]) - 1;
  const start = new Date(year, month, startDay);
  const end = new Date(year, month + 1, startDay);
  return { start: start, end: end };
}

function thisMonth_() {
  return Utilities.formatDate(new Date(), CONFIG.timezone, 'yyyy-MM');
}

function inWindow_(iso, win) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= win.start.getTime() && t < win.end.getTime();
}

function daysBetween_(from, to) {
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

/**
 * 거래가 등록해 둔 고정지출 중 하나인지 본다.
 * 이름이 가맹점에 들어 있으면 같은 것으로 취급한다.
 */
function matchRecurring_(txn, rules) {
  const merchant = normalizeMerchant_(txn.merchantRaw);
  if (!merchant) return null;
  for (let i = 0; i < rules.length; i++) {
    const name = normalizeMerchant_(rules[i].name);
    if (name && merchant.indexOf(name) >= 0) return rules[i];
  }
  return null;
}

function ledger(yyyymm) {
  const month = yyyymm || thisMonth_();
  const win = monthWindow_(month);
  const now = new Date();

  const rules = readAll_('RecurringRule');
  const settlements = readAll_('Settlement');
  const settledBy = {};
  settlements.forEach(function (s) { settledBy[s.txnId] = Number(s.receivedAmount || 0); });

  // ── 실제 ──────────────────────────────────────────────
  let actualIncome = 0;
  let actualFixed = 0;
  let actualVariable = 0;
  const byCategory = {};

  readAll_('Transaction').forEach(function (t) {
    if (t.status === 'voided') return;
    if (!inWindow_(t.occurredAt, win)) return;
    if (t.type === 'transfer') return;                       // 카드대금·저축은 지출이 아니다
    if (t.excludeFromBudget === true || t.excludeFromBudget === 'TRUE') return;

    if (t.type === 'income') { actualIncome += Number(t.amount || 0); return; }

    // 더치페이로 돌려받은 만큼은 내 돈이 아니다
    const net = Number(t.amount || 0) - (settledBy[t.id] || 0);
    if (net <= 0) return;

    if (matchRecurring_(t, rules)) actualFixed += net;
    else actualVariable += net;

    const key = t.categoryId || 'cat_unknown';
    byCategory[key] = (byCategory[key] || 0) + net;
  });

  // ── 계획 ──────────────────────────────────────────────
  const plannedIncome = Number(setting_('monthlyIncome', 0));
  const plannedFixed = rules.reduce(function (sum, r) {
    return sum + Number(r.expectedAmount || 0);
  }, 0);
  const variableBudget = Number(setting_('variableBudget', 0));
  const available = plannedIncome - plannedFixed - variableBudget;

  // ── 변동 예산 ─────────────────────────────────────────
  const daysLeft = Math.max(0, daysBetween_(now, win.end));
  const remaining = Math.max(0, variableBudget - actualVariable);

  // ── 부채 ──────────────────────────────────────────────
  const debts = readAll_('Debt')
    .filter(function (d) { return Number(d.balance || 0) > 0; })
    .sort(function (a, b) { return Number(b.rate || 0) - Number(a.rate || 0); });  // 비싼 빚부터

  const debtTotal = debts.reduce(function (sum, d) { return sum + Number(d.balance || 0); }, 0);
  const startAmount = Number(setting_('debtStartAmount', 0)) || debtTotal;
  const paid = Math.max(0, startAmount - debtTotal);
  const targetRaw = setting_('debtTargetDate', '');
  const target = targetRaw ? new Date(targetRaw) : null;

  const daysToTarget = target ? daysBetween_(now, target) : null;
  const monthsToTarget = daysToTarget === null ? null : daysToTarget / 30.44;
  const needPerMonth = (monthsToTarget && monthsToTarget > 0)
    ? Math.round(debtTotal / monthsToTarget) : null;
  const paceMonths = available > 0 ? debtTotal / available : null;

  return {
    month: month,
    planned: {
      income: plannedIncome, fixed: plannedFixed,
      variableBudget: variableBudget, available: available,
    },
    actual: {
      income: actualIncome, fixed: actualFixed,
      variable: actualVariable, byCategory: byCategory,
    },
    budget: {
      limit: variableBudget, spent: actualVariable, remaining: remaining,
      daysLeft: daysLeft,
      perDay: daysLeft > 0 ? Math.floor(remaining / daysLeft) : remaining,
      usedPct: variableBudget > 0 ? Math.round(actualVariable / variableBudget * 100) : 0,
    },
    debt: {
      items: debts,
      total: debtTotal,
      startAmount: startAmount,
      paid: paid,
      progressPct: startAmount > 0 ? Math.round(paid / startAmount * 100) : 0,
      targetDate: targetRaw,
      daysToTarget: daysToTarget,
      needPerMonth: needPerMonth,
      paceMonths: paceMonths === null ? null : Math.round(paceMonths * 10) / 10,
      shortfall: (needPerMonth !== null) ? Math.max(0, needPerMonth - available) : null,
      onTrack: (needPerMonth !== null) ? available >= needPerMonth : null,
    },
    inbox: {
      pending: readAll_('Transaction').filter(function (t) {
        return t.status === 'pendingCategory';
      }).length,
      unparsed: readAll_('RawMessage').filter(function (r) {
        return r.parsedOk !== true;
      }).length,
    },
  };
}
