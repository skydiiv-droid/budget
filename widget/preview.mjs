/**
 * 위젯을 HTML 로 다시 그려 본다. 개발용이고 앱에는 안 들어간다.
 *
 * widget.test.js 는 "무엇이 그려지는지"만 알려 주고 "읽히는지"는 안 알려 준다.
 * 다크 모드에서 글자가 안 보이는 사고를 한 번 냈다 — 밝은 모드 기준 색을
 * 박아 놓아서였다. 두 테마를 나란히 놓고 눈으로 본다.
 *
 *   npm i -D playwright
 *   node widget/preview.mjs   →  widget/preview.png
 *
 * 줄 간격과 밀어내기는 진짜 Scriptable 과 조금 다르다. 색과 대비를 보는 용도다.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// 앱에 안 들어가는 개발용이라 의존성을 리포에 들이지 않는다.
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('playwright 가 없어요.  npm i -D playwright  하고 다시 돌려 주세요.');
  process.exit(1);
}

const DATA = {
  ok: true, month: '2026-09',
  spent: 581_350, budget: 900_000, perDay: 33_565, daysLeft: 10,
  usedPct: 63, projected: 894_306, dayOf: 20, days: 30, dailyAvg: 29_068,
  lastMonthSameSpan: 395_000, debt: 3_580_000, goalPct: 15, goalName: '빚 정리',
  nextBill: { name: '현대 이마트Plus', total: 820_605, payAt: '2026-10-12', daysLeft: 22 },
  billTotal: 820_605, waiting: 3,
  top: [
    { id: 'f', name: '식비', icon: '🍚', amount: 133_800, pct: 24 },
    { id: 'e', name: '경조사', icon: '🎁', amount: 100_000, pct: 18 },
    { id: 's', name: '쇼핑', icon: '🛍️', amount: 89_300, pct: 16 },
  ],
};

/** Scriptable 을 흉내 내되, 이번엔 HTML 을 뱉는다. */
function collect(family, mode) {
  const pick = (c) => (c?.dynamic ? c.dynamic[mode === 'dark' ? 1 : 0] : c?.hex) || 'inherit';
  const nodes = [];
  const mk = (kind, parent) => { const n = { kind, parent, children: [], props: {} };
    nodes.push(n); if (parent) parent.children.push(n); return n; };
  const api = (n) => ({
    addText(t) { const c = mk('text', n); c.text = String(t);
      return { set font(v) { c.font = v; }, set textColor(v) { c.color = pick(v); },
               set textOpacity(v) { c.op = v; }, set lineLimit(v) {}, set minimumScaleFactor(v) {} }; },
    addStack() { return api(mk('stack', n)); },
    addSpacer(v) { const s = mk('spacer', n); s.size = v; },
    layoutVertically() { n.props.vertical = true; },
    layoutHorizontally() {}, centerAlignContent() { n.props.center = true; },
    set size(v) { n.props.size = v; }, set cornerRadius(v) { n.props.radius = v; },
    set backgroundColor(v) { n.props.bg = pick(v); }, set spacing(v) { n.props.gap = v; },
    set url(v) {},
  });
  const root = mk('root', null);
  root.props.vertical = true;        // ListWidget 은 세로로 쌓인다
  const w = api(root);
  w.setPadding = () => {};
  Object.defineProperty(w, 'refreshAfterDate', { set() {} });
  Object.defineProperty(w, 'url', { set() {} });
  Object.defineProperty(w, 'backgroundColor', { set(v) { root.props.bg = pick(v); } });

  globalThis.ListWidget = function () { return w; };
  globalThis.Color = function (hex) { return { hex }; };
  globalThis.Color.dynamic = (l, d) => ({ dynamic: [l.hex, d.hex], hex: l.hex });
  globalThis.Font = { systemFont: (s) => ({ size: s }), boldSystemFont: (s) => ({ size: s, bold: true }) };
  globalThis.Size = function (a, b) { return { w: a, h: b }; };
  globalThis.Script = { setWidget() {}, complete() {} };
  globalThis.Device = { screenSize: () => ({ width: 393, height: 852 }) };
  globalThis.config = { widgetFamily: family, runsInWidget: true };
  globalThis.__DATA = DATA;
  return root;
}

function html(n) {
  if (n.kind === 'text') {
    const f = n.font || {};
    return `<span style="color:${n.color};font-size:${f.size || 13}px;
      font-weight:${f.bold ? 700 : 400};opacity:${n.op ?? 1};white-space:nowrap">${n.text}</span>`;
  }
  if (n.kind === 'spacer') {
    // 크기를 준 것은 틈, 안 준 것은 밀어내는 놈. 가로줄에서는 가로로 민다.
    if (n.size) return `<div style="flex:0 0 ${n.size}px"></div>`;
    return '<div style="flex:1 1 auto"></div>';
  }
  const inner = n.children.map(html).join('');
  if (n.props.size && n.props.bg) {
    const fill = n.children.find((c) => c.props?.size);
    return `<div style="width:${n.props.size.w}px;height:${n.props.size.h}px;background:${n.props.bg};
      border-radius:${n.props.radius || 0}px;overflow:hidden">${fill
        ? `<div style="width:${fill.props.size.w}px;height:100%;background:${fill.props.bg};
            border-radius:${fill.props.radius || 0}px"></div>` : ''}</div>`;
  }
  const dir = n.props.vertical ? 'column' : 'row';
  const align = n.props.vertical ? 'flex-start' : 'center';
  return `<div style="display:flex;flex-direction:${dir};align-items:${align};
    gap:${n.props.gap || 0}px;${n.kind === 'root' ? 'flex:1' : ''}">${inner}</div>`;
}

const src = fs.readFileSync(join(HERE, 'budget-widget.js'), 'utf8')
  .replace(/const TOKEN = .*/, "const TOKEN='x';")
  .replace(/const URL = .*/, "const URL='x';")
  .replace(/async function load\(\)[\s\S]*?\n}/, 'async function load(){return globalThis.__DATA;}');

const cards = [];
for (const mode of ['light', 'dark']) {
  for (const [family, w, h] of [['large', 338, 354], ['medium', 338, 158], ['small', 158, 158]]) {
    const root = collect(family, mode);
    await import(`data:text/javascript;base64,${Buffer.from(`${src}\n// ${family}${mode}${Math.random()}`).toString('base64')}`);
    cards.push(`<figure><div class="w" style="width:${w}px;height:${h}px;background:${root.props.bg}">
      ${html(root)}</div><figcaption>${mode} · ${family}</figcaption></figure>`);
  }
}

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await b.newPage({ viewport: { width: 760, height: 1180 }, deviceScaleFactor: 2 });
await page.setContent(`<style>
 body{margin:0;padding:22px;background:#7e8aa0;font-family:system-ui;display:flex;
   flex-wrap:wrap;gap:22px;align-items:flex-start}
 .w{border-radius:22px;padding:12px 14px;box-sizing:border-box;overflow:hidden;
   box-shadow:0 8px 24px rgba(0,0,0,.3);display:flex;flex-direction:column}
 figure{margin:0}
 figcaption{color:#fff;font-size:11px;margin-top:7px;text-align:center;opacity:.85}
</style>${cards.join('')}`);
await page.waitForTimeout(500);
await page.screenshot({ path: join(HERE, 'preview.png'), fullPage: true });
await b.close();
