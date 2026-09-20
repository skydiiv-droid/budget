/**
 * 가계부 위젯 — Scriptable.
 *
 * 잠금화면에서 카드 긁기 직전에 눈에 들어오는 게 전부다. 그래서 띄우는 건
 * "오늘 쓸 수 있는 돈" 하나뿐이고, 자리가 남으면 그제야 나머지를 붙인다.
 *
 * 넣는 방법
 *   1. Scriptable 앱에서 새 스크립트를 만들고 이 파일 전체를 붙여 넣는다
 *   2. 아래 TOKEN 을 앱 설정 > 위젯 비밀번호에 넣은 값으로 바꾼다
 *   3. 잠금화면이나 홈 화면을 길게 눌러 위젯 추가 > Scriptable > 이 스크립트
 *
 * 크기마다 다르게 그린다
 *   잠금화면 한 줄  오늘 ₩12,400 · 11일
 *   잠금화면 원     게이지 + 남은 돈
 *   작은 위젯       오늘 쓸 수 있는 돈 + 이 달 진행
 *   중간 위젯       거기에 다음 카드값과 지난달 견줌까지
 */

const TOKEN = '여기에-위젯-비밀번호';
const URL = 'https://summary-6ygn4mmscq-du.a.run.app';

// 부호는 국내 관례 — 플러스가 빨강, 마이너스가 파랑
const BLUE = new Color('#1D6FE0');
const UP = new Color('#C7362B');
const DOWN = new Color('#1D6FE0');
const WARN = new Color('#C08A1E');
const INK = new Color('#10151C');
const MUTED = new Color('#5B6573');

const won = (n) => '₩' + Math.round(Number(n) || 0).toLocaleString('ko-KR');
const short = (n) => {
  const v = Math.round(Number(n) || 0);
  return v >= 10000 ? `${Math.round(v / 1000).toLocaleString('ko-KR')}천` : won(v);
};

async function load() {
  const req = new Request(`${URL}?token=${encodeURIComponent(TOKEN)}`);
  req.timeoutInterval = 8;
  const data = await req.loadJSON();
  if (!data.ok) throw new Error(data.message || data.reason);
  return data;
}

/** 예산을 안 잡았으면 "오늘 쓸 수 있는 돈"이 없다. 그때는 쓴 돈을 보여 준다. */
const headline = (d) => (d.budget
  ? { label: '오늘 쓸 수 있는 돈', value: d.perDay, color: d.perDay > 0 ? UP : WARN }
  : { label: '이 달에 쓴 돈', value: d.spent, color: INK });

function text(stack, s, { size = 13, color = INK, bold = false, opacity = 1 } = {}) {
  const t = stack.addText(String(s));
  t.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size);
  t.textColor = color;
  t.textOpacity = opacity;
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.7;
  return t;
}

/** 잠금화면은 흑백으로 나온다. 색 대신 글자로 말해야 한다. */
function accessoryInline(w, d) {
  const h = headline(d);
  text(w, d.budget ? `오늘 ${won(d.perDay)} · ${d.daysLeft}일` : `이 달 ${won(d.spent)}`,
       { size: 13 });
}

function accessoryCircular(w, d) {
  const h = headline(d);
  const ring = w.addStack();
  ring.layoutVertically();
  ring.centerAlignContent();
  text(ring, d.budget ? `${Math.min(99, d.usedPct)}%` : '쓴 돈', { size: 15, bold: true });
  text(ring, short(h.value), { size: 11 });
}

function accessoryRectangular(w, d) {
  const h = headline(d);
  text(w, h.label, { size: 11, opacity: 0.7 });
  text(w, won(h.value), { size: 20, bold: true });
  if (d.budget) text(w, `${d.usedPct}% 썼고 ${d.daysLeft}일 남음`, { size: 11, opacity: 0.7 });
  else if (d.lastMonthSameSpan) text(w, `지난달 같은 기간 ${short(d.lastMonthSameSpan)}`,
                                     { size: 11, opacity: 0.7 });
}

function bar(stack, pct, color) {
  const row = stack.addStack();
  row.size = new Size(0, 6);
  row.cornerRadius = 3;
  row.backgroundColor = new Color('#E4EAF2');
  const fill = row.addStack();
  fill.size = new Size(Math.max(4, Math.min(140, Math.round(140 * (pct / 100)))), 6);
  fill.cornerRadius = 3;
  fill.backgroundColor = color;
  row.addSpacer();
}

function small(w, d) {
  const h = headline(d);
  text(w, h.label, { size: 11, color: MUTED });
  w.addSpacer(3);
  text(w, won(h.value), { size: 24, bold: true, color: h.color });
  w.addSpacer(8);
  if (d.budget) {
    bar(w, Math.min(100, d.usedPct), d.usedPct > 100 ? WARN : BLUE);
    w.addSpacer(5);
    text(w, `${d.usedPct}% · ${d.daysLeft}일 남음`, { size: 11, color: MUTED });
  } else {
    text(w, `이 속도면 ${short(d.projected)}`, { size: 11, color: MUTED });
  }
  if (d.waiting) {
    w.addSpacer(4);
    text(w, `정리할 게 ${d.waiting}건`, { size: 11, color: WARN, bold: true });
  }
}

function medium(w, d) {
  const cols = w.addStack();
  cols.spacing = 14;

  const left = cols.addStack();
  left.layoutVertically();
  small(left, d);

  cols.addSpacer();

  const right = cols.addStack();
  right.layoutVertically();
  if (d.nextBill) {
    text(right, '다음 카드값', { size: 11, color: MUTED });
    right.addSpacer(3);
    text(right, won(d.billTotal), { size: 17, bold: true, color: DOWN });
    text(right, `${d.nextBill.payAt.slice(5).replace('-', '/')} · ${d.nextBill.daysLeft}일 뒤`,
         { size: 11, color: MUTED });
    right.addSpacer(8);
  }
  if (d.lastMonthSameSpan) {
    const gap = d.spent - d.lastMonthSameSpan;
    text(right, '지난달 같은 기간보다', { size: 11, color: MUTED });
    right.addSpacer(2);
    text(right, `${gap >= 0 ? '+' : '−'}${short(Math.abs(gap))}`,
         { size: 17, bold: true, color: gap > 0 ? WARN : UP });
  }
  if (d.goalPct !== null && d.goalPct !== undefined) {
    right.addSpacer(8);
    text(right, `${d.goalName} ${d.goalPct}%`, { size: 11, color: MUTED });
  }
}

function oops(w, err) {
  text(w, '가계부', { size: 12, color: MUTED });
  w.addSpacer(4);
  text(w, '불러오지 못했어요', { size: 14, bold: true });
  w.addSpacer(2);
  const t = w.addText(String(err.message || err));
  t.font = Font.systemFont(10);
  t.textColor = MUTED;
  t.lineLimit = 3;
}

const w = new ListWidget();
w.url = 'https://budget-13aec.web.app';
w.setPadding(12, 14, 12, 14);

try {
  const d = await load();
  const family = config.widgetFamily || 'medium';
  if (family === 'accessoryInline') accessoryInline(w, d);
  else if (family === 'accessoryCircular') accessoryCircular(w, d);
  else if (family === 'accessoryRectangular') accessoryRectangular(w, d);
  else if (family === 'medium' || family === 'large') medium(w, d);
  else small(w, d);
  // 문자가 들어올 때마다 바뀌니 자주 다시 그린다. 실제 주기는 iOS 가 정한다.
  w.refreshAfterDate = new Date(Date.now() + 20 * 60 * 1000);
} catch (err) {
  oops(w, err);
  w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
}

if (config.runsInWidget) Script.setWidget(w);
else await w.presentMedium();
Script.complete();
