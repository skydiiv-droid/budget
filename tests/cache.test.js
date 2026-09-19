/**
 * 시트 읽기 캐시.
 *
 * 시트 한 번 읽기가 이 앱에서 가장 비싼 일이다. 대시보드를 한 번 여는 것만으로
 * Transaction 전체를 미분류 건수 × 3번씩 읽고 있어 쓸 수 없이 느렸다.
 * 여기서는 진짜 Schema.gs 를 올리고 시트 접근을 세어 캐시가 도는지 본다.
 */
const assert = require('assert');
const { load } = require('./harness');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failed++; console.log('  FAIL ' + name + '\n       ' + err.message); }
}

/** 읽은 횟수를 세는 가짜 스프레드시트. */
function fakeSheets(rowsBySheet) {
  const reads = {};
  const makeSheet = (name) => ({
    getDataRange: () => {
      reads[name] = (reads[name] || 0) + 1;
      return { getValues: () => rowsBySheet[name] || [] };
    },
    appendRow() {},
    getRange: () => ({ setValues() { return this; }, setValue() {}, setFontWeight() {} }),
    setFrozenRows() {},
  });
  const sheets = {};
  Object.keys(rowsBySheet).forEach((n) => { sheets[n] = makeSheet(n); });
  return {
    reads,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (n) => sheets[n] || null,
        insertSheet: (n) => (sheets[n] = makeSheet(n)),
        getSheets: () => Object.keys(sheets).map((n) => ({ getName: () => n })),
        getName: () => 'test', getUrl: () => 'about:blank', toast() {},
      }),
      flush() {},
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  };
}

console.log('\n읽기 캐시');

const TXN = [['id', 'amount'], ['t1', 1000], ['t2', 2000]];

check('같은 시트를 여러 번 읽어도 실제로는 한 번만 읽는다', () => {
  const fake = fakeSheets({ Transaction: TXN });
  const ctx = load(['Config.gs', 'Util.gs', 'Schema.gs'], fake);
  ctx.readAll_('Transaction');
  ctx.readAll_('Transaction');
  ctx.readAll_('Transaction');
  assert.strictEqual(fake.reads.Transaction, 1, '세 번 불러도 시트는 한 번만 닿아야 한다');
});

check('읽은 내용은 그대로 나온다', () => {
  const fake = fakeSheets({ Transaction: TXN });
  const ctx = load(['Config.gs', 'Util.gs', 'Schema.gs'], fake);
  const rows = ctx.readAll_('Transaction');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].id, 't1');
  assert.strictEqual(rows[1].amount, 2000);
});

check('행을 더하면 다음 읽기는 시트를 다시 본다', () => {
  const fake = fakeSheets({ Transaction: TXN });
  const ctx = load(['Config.gs', 'Util.gs', 'Schema.gs'], fake);
  ctx.readAll_('Transaction');
  ctx.append_('Transaction', { id: 't3', amount: 3000 });
  ctx.readAll_('Transaction');
  assert.strictEqual(fake.reads.Transaction, 2, '쓴 뒤에도 옛 값을 돌려주면 안 된다');
});

check('한 시트에 쓴다고 다른 시트 캐시까지 버리지 않는다', () => {
  const fake = fakeSheets({ Transaction: TXN, Category: [['id', 'name'], ['c1', '카페']] });
  const ctx = load(['Config.gs', 'Util.gs', 'Schema.gs'], fake);
  ctx.readAll_('Transaction');
  ctx.readAll_('Category');
  ctx.append_('Category', { id: 'c2', name: '외식' });
  ctx.readAll_('Transaction');
  ctx.readAll_('Category');
  assert.strictEqual(fake.reads.Transaction, 1, '건드리지 않은 시트는 그대로 둔다');
  assert.strictEqual(fake.reads.Category, 2, '쓴 시트만 다시 읽는다');
});

check('빈 시트도 한 번만 읽는다', () => {
  const fake = fakeSheets({ Debt: [] });
  const ctx = load(['Config.gs', 'Util.gs', 'Schema.gs'], fake);
  assert.deepStrictEqual(ctx.readAll_('Debt').length, 0);
  ctx.readAll_('Debt');
  assert.strictEqual(fake.reads.Debt, 1, '비어 있다고 캐시를 안 하면 매번 다시 읽는다');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
