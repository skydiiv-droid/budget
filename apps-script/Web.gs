/**
 * 웹 대시보드. doGet 이 페이지를 통째로 내려보내고,
 * 페이지는 google.script.run 으로 아래 api* 함수를 불러 값을 고친다.
 *
 * 시트를 열지 않고 앱 안에서 부채·고정지출·예산을 고칠 수 있게 하는 게 목적이다.
 */

function requireToken_(token) {
  if (token !== getIngestToken_()) throw new Error('unauthorized');
}

function apiLoad(token) {
  requireToken_(token);
  return {
    ledger: ledger(),
    debts: readAll_('Debt'),
    recurring: readAll_('RecurringRule').sort(function (a, b) {
      return (Number(a.dayOfMonth) || 0) - (Number(b.dayOfMonth) || 0);
    }),
    settings: {
      monthlyIncome: setting_('monthlyIncome', 0),
      variableBudget: setting_('variableBudget', 0),
      debtStartAmount: setting_('debtStartAmount', 0),
      debtStartDate: setting_('debtStartDate', ''),
      debtTargetDate: setting_('debtTargetDate', ''),
    },
    categories: readAll_('Category').filter(function (c) { return c.kind === 'expense'; }),
  };
}

function apiSaveSettings(token, patch) {
  requireToken_(token);
  Object.keys(patch).forEach(function (key) { putSetting_(key, patch[key]); });
  return apiLoad(token);
}

function apiSaveDebt(token, debt) {
  requireToken_(token);
  const row = {
    name: String(debt.name || '').trim(),
    kind: debt.kind || 'loan',
    balance: parseAmount_(debt.balance) || 0,
    rate: Number(debt.rate) || 0,
    billingDay: Number(debt.billingDay) || '',
    note: debt.note || '',
    sortOrder: Number(debt.sortOrder) || 0,
  };
  if (!row.name) throw new Error('이름을 적어 주세요');

  if (debt.id && findBy_('Debt', 'id', debt.id)) update_('Debt', debt.id, row);
  else { row.id = newId_('debt'); append_('Debt', row); }
  return apiLoad(token);
}

function apiSaveRecurring(token, rule) {
  requireToken_(token);
  const row = {
    name: String(rule.name || '').trim(),
    expectedAmount: parseAmount_(rule.expectedAmount) || 0,
    dayOfMonth: Number(rule.dayOfMonth) || '',
    accountId: rule.accountId || '',
    categoryId: rule.categoryId || '',
    autoDetected: false,
    lastMatchedTxnId: '',
  };
  if (!row.name) throw new Error('이름을 적어 주세요');

  if (rule.id && findBy_('RecurringRule', 'id', rule.id)) update_('RecurringRule', rule.id, row);
  else { row.id = newId_('rec'); append_('RecurringRule', row); }
  return apiLoad(token);
}

/** 행 하나를 지운다. 뒤에서부터 찾아야 행 번호가 밀리지 않는다. */
function deleteRow_(sheetName, id) {
  const sheet = sheet_(sheetName);
  const idCol = SCHEMA[sheetName].indexOf('id');
  const values = sheet.getDataRange().getValues();
  for (let r = values.length - 1; r >= 1; r--) {
    if (values[r][idCol] === id) { sheet.deleteRow(r + 1); return true; }
  }
  return false;
}

function apiDeleteDebt(token, id) {
  requireToken_(token);
  deleteRow_('Debt', id);
  return apiLoad(token);
}

function apiDeleteRecurring(token, id) {
  requireToken_(token);
  deleteRow_('RecurringRule', id);
  return apiLoad(token);
}

function dashboardHtml_(token) {
  return DASHBOARD_HTML.replace('__TOKEN__', token);
}
