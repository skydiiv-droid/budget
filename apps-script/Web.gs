/**
 * 웹 대시보드. doGet 이 페이지를 통째로 내려보내고,
 * 페이지는 google.script.run 으로 아래 api* 함수를 불러 값을 고친다.
 *
 * 시트를 열지 않고 앱 안에서 부채·고정지출·예산을 고칠 수 있게 하는 게 목적이다.
 */

function requireToken_(token) {
  if (!tokenMatches_(token)) throw new Error('unauthorized');
}

/**
 * 화면이 쓸 값을 한 번에 내려보낸다.
 *
 * 만드는 데 드는 시간이 적지 않아 잠깐 재어 둔다. 무엇이든 고치면 곧바로
 * 버리므로, 고친 값이 안 보이는 일은 없다. 재는 칸이 100KB까지라
 * 그보다 큰 짐은 그냥 매번 만든다.
 */
function apiLoad(token) {
  requireToken_(token);

  const cache = CacheService.getScriptCache();
  try {
    const hit = cache.get('payload');
    if (hit) return JSON.parse(hit);
  } catch (e) { /* 캐시는 없어도 그만이다 */ }

  const data = buildPayload_();

  try {
    const text = JSON.stringify(data);
    if (text.length < 90000) cache.put('payload', text, 300);
  } catch (e) { /* 마찬가지 */ }

  return data;
}

/** 값이 바뀌었으니 재어 둔 것을 버린다. */
function bustPayload_() {
  try { CacheService.getScriptCache().remove('payload'); } catch (e) {}
}

function buildPayload_() {
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
    accounts: readAll_('Account'),
    categories: readAll_('Category').filter(function (c) { return c.kind === 'expense'; }),
    pending: pendingItems_(),
    unparsed: unparsedItems_(),
  };
}

/**
 * 아직 분류하지 않은 거래. 화면이 바로 그릴 수 있게 미리 갖춰 보낸다.
 * 고를 만한 카테고리와 규칙 범위까지 서버가 정해 준다.
 */
function pendingItems_() {
  const accounts = {};
  readAll_('Account').forEach(function (a) { accounts[a.id] = a.name; });

  return readAll_('Transaction')
    .filter(function (t) { return t.status === 'pendingCategory' && t.type === 'expense'; })
    .sort(function (a, b) { return String(b.occurredAt).localeCompare(String(a.occurredAt)); })
    .slice(0, 30)
    .map(function (t) {
      const nearby = nearbyCategory_(
        (t.lat === '' || t.lat === null || t.lat === undefined)
          ? null : { lat: t.lat, lon: t.lon });

      return {
        id: t.id,
        merchant: t.merchantRaw || '(가맹점 미상)',
        amount: Number(t.amount || 0),
        occurredAt: t.occurredAt,
        account: accounts[t.accountId] || '',
        suggestions: suggestionsFor_({ nearby: nearby }),
        scopeOptions: scopeMenuText_(t.merchantRaw).split('\n'),
        nearbyNote: (nearby && nearby.categoryId && nearby.samples)
          ? ('같은 자리에서 ' + nearby.samples + '번') : '',
      };
    });
}

/** 파서가 읽지 못한 문자. 원문을 보여 주고 손으로 넣게 한다. */
function unparsedItems_() {
  return readAll_('RawMessage')
    .filter(function (r) { return r.parsedOk !== true && !r.txnId; })
    .sort(function (a, b) { return String(b.receivedAt).localeCompare(String(a.receivedAt)); })
    .slice(0, 20)
    .map(function (r) {
      return { id: r.id, body: r.body, receivedAt: r.receivedAt, note: r.parseNote || '' };
    });
}

/** 인박스에서 카테고리를 고르면 호출된다. categorize 와 같은 일을 한다. */
function apiCategorize(token, payload) {
  requireToken_(token);
  const result = categorize(payload);
  if (result.status !== 'ok') throw new Error(result.reason || '분류하지 못했어요');
  bustPayload_();
  return apiLoad(token);
}

/** 읽지 못한 문자를 손으로 거래로 만든다. */
function apiManualFromRaw(token, payload) {
  requireToken_(token);
  const raw = findBy_('RawMessage', 'id', payload.rawId);
  if (!raw) throw new Error('문자를 찾을 수 없어요');

  const amount = parseAmount_(payload.amount);
  if (!amount) throw new Error('금액을 넣어 주세요');

  const txn = manualEntry({
    amount: amount,
    merchant: payload.merchant || '',
    categoryId: payload.categoryId || '',
    occurredAt: raw.receivedAt,
    accountId: payload.accountId || '',
  });
  update_('RawMessage', raw.id, { txnId: txn.txnId, parsedOk: true, parseNote: '손으로 넣음' });
  bustPayload_();
  return apiLoad(token);
}

/** 거래가 아닌 문자(광고 등)를 치운다. 원문은 남긴다. */
function apiIgnoreRaw(token, rawId) {
  requireToken_(token);
  update_('RawMessage', rawId, { parsedOk: true, parseNote: '거래 아님' });
  bustPayload_();
  return apiLoad(token);
}

function apiSaveSettings(token, patch) {
  requireToken_(token);
  Object.keys(patch).forEach(function (key) { putSetting_(key, patch[key]); });
  bustPayload_();
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
  bustPayload_();
  return apiLoad(token);
}

/** 통장·현금·저축 같은 자산을 더하거나 잔액을 고친다. */
function apiSaveAccount(token, account) {
  requireToken_(token);
  const name = String(account.name || '').trim();
  if (!name) throw new Error('이름을 적어 주세요');

  const row = {
    name: name,
    type: account.type || 'savings',
    balance: parseAmount_(account.balance) || 0,
    balanceAt: nowIso_(),
    active: true,
  };

  if (account.id && findBy_('Account', 'id', account.id)) {
    update_('Account', account.id, row);
    bustPayload_();
  return apiLoad(token);
  }

  // 같은 이름이 있으면 새로 만들지 않고 잔액만 고친다
  const same = readAll_('Account').filter(function (a) { return a.name === name; })[0];
  if (same) update_('Account', same.id, row);
  else {
    row.id = newId_('acc');
    row.issuer = ''; row.last4 = ''; row.closingDay = ''; row.billingDay = '';
    append_('Account', row);
  }
  bustPayload_();
  return apiLoad(token);
}

function apiDeleteAccount(token, id) {
  requireToken_(token);
  deleteRow_('Account', id);
  bustPayload_();
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
  bustPayload_();
  return apiLoad(token);
}

/** 행 하나를 지운다. 뒤에서부터 찾아야 행 번호가 밀리지 않는다. */
function deleteRow_(sheetName, id) {
  const sheet = sheet_(sheetName);
  const idCol = SCHEMA[sheetName].indexOf('id');
  const values = sheet.getDataRange().getValues();
  for (let r = values.length - 1; r >= 1; r--) {
    if (values[r][idCol] === id) { sheet.deleteRow(r + 1); invalidate_(sheetName); return true; }
  }
  return false;
}

function apiDeleteDebt(token, id) {
  requireToken_(token);
  deleteRow_('Debt', id);
  bustPayload_();
  return apiLoad(token);
}

function apiDeleteRecurring(token, id) {
  requireToken_(token);
  deleteRow_('RecurringRule', id);
  bustPayload_();
  return apiLoad(token);
}

/**
 * 토큰을 바꾼다.
 *
 * URL이 길어서 무작위 문자열을 쓸 이유는 없다. 외우기 쉬운 문장이어도
 * 길면 충분하다. 다만 주소에 붙일 수 있는 값이어야 하므로 URL에서 뜻을
 * 갖는 글자는 막는다.
 *
 * 바꾸고 나면 아이폰 단축어의 token 값도 고쳐야 문자가 계속 들어온다.
 */
function apiChangeToken(token, newToken) {
  requireToken_(token);

  const next = String(newToken || '').trim();
  if (next.length < 8) throw new Error('8자 이상으로 해 주세요');
  if (/[\s&?#%+/]/.test(next)) throw new Error('공백과 & ? # % + / 는 쓸 수 없어요');

  PropertiesService.getScriptProperties().setProperty('INGEST_TOKEN', next);   // 이미 trim 된 값
  TOKEN_ = next;
  return { status: 'ok' };
}

function dashboardHtml_(token) {
  return DASHBOARD_HTML.replace('__TOKEN__', token);
}
