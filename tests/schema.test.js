/**
 * 코드가 쓰는 시트 이름이 전부 SCHEMA에 있는지 본다.
 *
 * SCHEMA에 없는 시트는 ensureSheets_() 가 만들지 않는다. 그래서 평소에는
 * 조용하다가, 그 시트를 처음 읽는 화면을 열 때 비로소 터진다.
 * 실제로 RecurringRule 이 그렇게 빠져 대시보드가 열리지 않았다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'apps-script');
const ACCESSORS = /(?:readAll_|sheet_|append_|findBy_|update_|deleteRow_)\(\s*'([A-Za-z]+)'/g;

let passed = 0;
let failed = 0;

function check(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failed++; console.log('  FAIL ' + name + '\n       ' + err.message); }
}

function schemaKeys() {
  const text = fs.readFileSync(path.join(SRC, 'Schema.gs'), 'utf8');
  const block = text.slice(text.indexOf('const SCHEMA = {'), text.indexOf('\n};'));
  return block.split('\n')
    .map((line) => /^\s{2}([A-Za-z]+):/.exec(line))
    .filter(Boolean)
    .map((m) => m[1]);
}

function referencedSheets() {
  const names = new Set();
  fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).forEach((file) => {
    const text = fs.readFileSync(path.join(SRC, file), 'utf8');
    let m;
    while ((m = ACCESSORS.exec(text)) !== null) names.add(m[1]);
  });
  return [...names].sort();
}

console.log('\n스키마');

check('코드가 쓰는 시트가 전부 SCHEMA에 있다', () => {
  const keys = schemaKeys();
  const missing = referencedSheets().filter((n) => keys.indexOf(n) < 0);
  assert.deepStrictEqual(missing, [],
    'SCHEMA에 없으면 시트가 만들어지지 않아, 그 시트를 처음 읽는 순간 터진다');
});

check('SCHEMA의 모든 시트에 id나 key 열이 있다', () => {
  const text = fs.readFileSync(path.join(SRC, 'Schema.gs'), 'utf8');
  const block = text.slice(text.indexOf('const SCHEMA = {'), text.indexOf('\n};'));
  const bad = [];
  const re = /^\s{2}([A-Za-z]+):\s*(\[[^\]]*\])/gm;
  let m;
  while ((m = re.exec(block)) !== null) {
    const cols = m[2];
    if (cols.indexOf("'id'") < 0 && cols.indexOf("'key'") < 0) bad.push(m[1]);
  }
  assert.deepStrictEqual(bad, [], 'update_ 와 findBy_ 가 행을 찾지 못한다');
});

console.log('\n토큰');

const { load } = require('./harness');

function tokenCtx(stored) {
  const box = { INGEST_TOKEN: stored };
  return load(['Config.gs'], {
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => box[k],
      setProperty: (k, v) => { box[k] = v; },
    }) },
  });
}

check('속성에 딸려 들어간 공백 때문에 막히지 않는다', () => {
  const ctx = tokenCtx('  bk7Qz2mXr9Lp4vT8w\n');
  assert.ok(ctx.tokenMatches_('bk7Qz2mXr9Lp4vT8w'), '화면에서 친 값은 앞뒤가 깎여 온다');
  assert.ok(ctx.tokenMatches_('  bk7Qz2mXr9Lp4vT8w\n'), '단축어는 붙여넣은 그대로 보낸다');
});

check('틀린 토큰과 빈 토큰은 막는다', () => {
  const ctx = tokenCtx('bk7Qz2mXr9Lp4vT8w');
  assert.ok(!ctx.tokenMatches_('다른값'));
  assert.ok(!ctx.tokenMatches_(''));
  assert.ok(!ctx.tokenMatches_(null));
});

check('속성이 공백뿐이면 없는 것으로 본다', () => {
  const ctx = tokenCtx('   ');
  assert.throws(() => ctx.getIngestToken_(), /INGEST_TOKEN/);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
