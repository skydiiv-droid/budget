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
 *   큰 위젯         이 달 총액 · 예산 대비 · 하루 평균 · 이 속도면 · 어디에 썼나
 */

const TOKEN = '여기에-위젯-비밀번호';
const URL = 'https://summary-6ygn4mmscq-du.a.run.app';

/**
 * 색.
 *
 * 위젯 바탕은 시스템 테마를 따라간다. 밝은 모드 기준으로 글자색을 박으면
 * 다크 모드에서 어두운 바탕에 어두운 글자가 되어 아무것도 안 보인다.
 * 두 벌을 다 들고 다니고 iOS 가 그릴 때 고르게 한다.
 *
 * 다크 쪽은 밝은 쪽을 그냥 뒤집은 게 아니라 어두운 바탕에 맞춰 따로 골랐다.
 * 부호는 국내 관례 — 플러스가 빨강, 마이너스가 파랑.
 */
function dyn(light, dark) {
  const l = new Color(light);
  try {
    return Color.dynamic(l, new Color(dark));
  } catch {
    return l;                      // 아주 옛 Scriptable 이면 밝은 쪽으로
  }
}

const SURFACE = dyn('#FFFFFF', '#161A20');
const INK = dyn('#10151C', '#F2F5F9');     // 15.97:1 / 18.32:1
const MUTED = dyn('#5B6573', '#98A4B3');   //  5.91:1 /  6.90:1
const BLUE = dyn('#1D6FE0', '#4E86DE');
const DOWN = BLUE;                          // 나간 돈 · 부채
const UP = dyn('#C7362B', '#D9604F');       // 들어온 돈 · 잔액
const WARN = dyn('#C08A1E', '#E0AE4A');     // 예산 넘김 — 부호가 아니라 경고다
const TRACK = dyn('#E4EAF2', '#2A3340');

const won = (n) => '₩' + Math.round(Number(n) || 0).toLocaleString('ko-KR');

/** 좁은 자리용. "186천"은 한국어가 아니다 — 만 단위로 끊는다. */
const short = (n) => {
  const v = Math.round(Number(n) || 0);
  if (v < 10000) return won(v);
  const man = v / 10000;
  return `${man >= 10 ? Math.round(man) : man.toFixed(1)}만`;
};

/**
 * 막대에 쓸 폭.
 *
 * Scriptable 은 남은 자리를 알려 주지 않아 숫자를 박아야 하는데, 박으면 작은
 * 폰에서 넘치고 큰 폰에서 짧아 보인다. 화면 너비에서 되짚어 낸다.
 */
function barWidth(pad = 28) {
  try {
    return Math.max(210, Math.min(320, Math.round(Device.screenSize().width * 0.78) - pad));
  } catch {
    return 250;
  }
}

async function load() {
  const req = new Request(`${URL}?token=${encodeURIComponent(TOKEN)}`);
  req.timeoutInterval = 8;
  const data = await req.loadJSON();
  if (!data.ok) throw new Error(data.message || data.reason);
  return data;
}

/** 예산을 안 잡았으면 "오늘 쓸 수 있는 돈"이 없다. 그때는 쓴 돈을 보여 준다. */
const headline = (d) => (d.budget
  ? { label: '오늘 사용 가능액', value: d.perDay, color: d.perDay > 0 ? UP : WARN }
  : { label: '이번 달 지출', value: d.spent, color: INK });

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
  text(w, d.budget ? `오늘 ${won(d.perDay)} · ${d.daysLeft}일` : `이번 달 ${won(d.spent)}`,
       { size: 13 });
}

function accessoryCircular(w, d) {
  const h = headline(d);
  const ring = w.addStack();
  ring.layoutVertically();
  ring.centerAlignContent();
  text(ring, d.budget ? `${Math.min(99, d.usedPct)}%` : '지출', { size: 15, bold: true });
  text(ring, short(h.value), { size: 11 });
}

function accessoryRectangular(w, d) {
  const h = headline(d);
  text(w, h.label, { size: 11, opacity: 0.7 });
  text(w, won(h.value), { size: 20, bold: true });
  if (d.budget) text(w, `${d.usedPct}% 사용 · ${d.daysLeft}일 남음`, { size: 11, opacity: 0.7 });
  else if (d.lastMonthSameSpan) text(w, `지난달 같은 기간 ${short(d.lastMonthSameSpan)}`,
                                     { size: 11, opacity: 0.7 });
}

function bar(stack, pct, color, width = 140, height = 6) {
  const row = stack.addStack();
  row.size = new Size(width, height);
  row.cornerRadius = height / 2;
  row.backgroundColor = TRACK;
  const fill = row.addStack();
  fill.size = new Size(Math.max(height, Math.round(width * (Math.min(100, pct) / 100))), height);
  fill.cornerRadius = height / 2;
  fill.backgroundColor = color;
  row.addSpacer();
}

/** 값을 오른쪽에 붙여 한 줄로. 라벨과 숫자가 멀어야 둘 다 읽힌다. */
function row(stack, label, value, opts = {}) {
  const line = stack.addStack();
  line.centerAlignContent();
  text(line, label, { size: opts.small ? 11 : 12.5, color: MUTED });
  line.addSpacer();
  text(line, value, { size: opts.small ? 12 : 15, bold: true, color: opts.color || INK });
  return line;
}

function small(w, d) {
  const h = headline(d);
  text(w, h.label, { size: 11, color: MUTED });
  w.addSpacer(3);
  text(w, won(h.value), { size: 24, bold: true, color: h.color });
  w.addSpacer(8);
  if (d.budget) {
    bar(w, Math.min(100, d.usedPct), d.usedPct > 100 ? WARN : BLUE, barWidth(140));
    w.addSpacer(5);
    text(w, `${d.usedPct}% · ${d.daysLeft}일 남음`, { size: 11, color: MUTED });
  } else {
    if (d.enoughForPace) text(w, `예상 ${short(d.projected)}`, { size: 11, color: MUTED });
  }
  if (d.waiting) {
    w.addSpacer(4);
    text(w, `확인할 내역 ${d.waiting}건`, { size: 11, color: WARN, bold: true });
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
    text(right, '다음 카드 결제', { size: 11, color: MUTED });
    right.addSpacer(3);
    text(right, won(d.billTotal), { size: 17, bold: true, color: DOWN });
    text(right, `${d.nextBill.payAt.slice(5).replace('-', '/')} · ${d.nextBill.daysLeft}일 후`,
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

/**
 * 큰 위젯.
 *
 * 자리가 넉넉하니 "얼마 썼나"에서 끝내지 않고 "그래서 이 달이 어떻게 되나"까지
 * 내려간다. 총액 → 예산 대비 → 하루 평균 → 이 속도면 얼마 → 어디에 썼나.
 * 위에서 아래로 갈수록 좁아지는 순서다.
 */
function large(w, d) {
  const over = d.budget && d.spent > d.budget;

  // ── 이 달에 쓴 돈 ───────────────────────────────────────
  const head = w.addStack();
  head.centerAlignContent();
  text(head, '이번 달 지출', { size: 12, color: MUTED });
  head.addSpacer();
  if (d.days) text(head, `${d.dayOf}/${d.days}일`, { size: 11, color: MUTED });

  w.addSpacer(4);
  text(w, won(d.spent), { size: 34, bold: true, color: over ? WARN : INK });

  if (d.budget) {
    w.addSpacer(9);
    bar(w, d.usedPct, over ? WARN : BLUE, barWidth(), 7);
    w.addSpacer(5);
    text(w, `예산 ${won(d.budget)} 중 ${d.usedPct}%${
      over ? ` · ${won(d.spent - d.budget)} 초과` : ` · ${d.daysLeft}일 남음`}`,
      { size: 11, color: over ? WARN : MUTED });
  }

  // ── 하루 평균 · 이 속도면 ────────────────────────────────
  w.addSpacer(12);
  row(w, '하루 평균', won(d.dailyAvg || 0));
  w.addSpacer(6);
  // 달 초 며칠치로 한 달을 점치면 숫자가 요동친다. 그때는 예상을 걸지 않는다.
  if (d.enoughForPace) {
    const end = d.budget ? (d.projected > d.budget ? WARN : UP) : INK;
    row(w, '이번 달 예상', won(d.projected || 0), { color: end });
    if (d.budget) {
      w.addSpacer(2);
      const gap = (d.projected || 0) - d.budget;
      text(w, gap > 0 ? `예산 ${won(gap)} 초과 예상` : `예산 ${won(-gap)} 미만 예상`,
        { size: 11, color: gap > 0 ? WARN : MUTED });
    }
  } else {
    row(w, '이번 달 예상', '아직 이르다', { color: MUTED });
  }

  // ── 어디에 썼나 ─────────────────────────────────────────
  // 자리가 셋뿐이다. 서버가 더 줘도 넘치게 그리지 않는다.
  const top = (d.top || []).slice(0, 3);
  if (!top.length) return;

  w.addSpacer(12);
  text(w, '카테고리별 지출', { size: 12, color: MUTED });
  w.addSpacer(6);

  const most = top[0].amount || 1;
  for (const c of top) {
    const line = w.addStack();
    line.centerAlignContent();
    text(line, `${c.icon} ${c.name}`.trim(), { size: 12.5 });
    line.addSpacer();
    text(line, won(c.amount), { size: 12.5, bold: true });
    text(line, `  ${c.pct}%`, { size: 11, color: MUTED });
    w.addSpacer(3);
    bar(w, Math.round((c.amount / most) * 100), BLUE, barWidth(), 4);
    w.addSpacer(7);
  }
}

function oops(w, err) {
  text(w, '가계부', { size: 12, color: MUTED });
  w.addSpacer(4);
  text(w, '불러오지 못했습니다', { size: 14, bold: true });
  w.addSpacer(2);
  const t = w.addText(String(err.message || err));
  t.font = Font.systemFont(10);
  t.textColor = MUTED;
  t.lineLimit = 3;
}

const w = new ListWidget();
w.url = 'https://budget-13aec.web.app';
w.setPadding(12, 14, 12, 14);

/**
 * 잠금화면 위젯은 iOS 가 제 방식으로 칠한다 — 바탕을 주면 네모 상자가 생긴다.
 * 홈 화면 위젯에만 바탕을 깐다. 깔아 두면 대비가 계산대로 유지된다.
 */
if (!String(config.widgetFamily || '').startsWith('accessory')) {
  w.backgroundColor = SURFACE;
}

try {
  const d = await load();
  const family = config.widgetFamily || 'medium';
  if (family === 'accessoryInline') accessoryInline(w, d);
  else if (family === 'accessoryCircular') accessoryCircular(w, d);
  else if (family === 'accessoryRectangular') accessoryRectangular(w, d);
  else if (family === 'large') large(w, d);
  else if (family === 'medium') medium(w, d);
  else small(w, d);
  // 문자가 들어올 때마다 바뀌니 자주 다시 그린다. 실제 주기는 iOS 가 정한다.
  w.refreshAfterDate = new Date(Date.now() + 20 * 60 * 1000);
} catch (err) {
  oops(w, err);
  w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
}

if (config.runsInWidget) Script.setWidget(w);
else if (config.widgetFamily === 'large') await w.presentLarge();
else await w.presentMedium();
Script.complete();
