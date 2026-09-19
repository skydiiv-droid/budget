/**
 * 화면.
 *
 * Firestore 를 직접 읽는다. 함수를 거치지 않는 이유는 콜드 스타트 때문이다 —
 * 매번 함수를 깨우면 앱스 스크립트를 떠난 이유가 없어진다.
 * 대신 보안 규칙이 막는다. 사람은 로그인으로, 기계(단축어)는 토큰으로.
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc,
  deleteDoc, writeBatch, query, orderBy, limit,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

import { ledger, monthSpending, breakdown, shiftMonth, monthKey, sameSpanLastMonth, pace }
  from './shared/ledger.js';
import { TYPE_LABEL, CARD_LABEL, debtOf, cashOf } from './shared/accounts.js';
import { findOriginal, openCancels, voidPatch, settledPatch } from './shared/cancel.js';
import { trend, categoryBudgets } from './shared/ledger.js';
import { search, knownTags, parseTags } from './shared/search.js';
import { toCSV } from './shared/csv.js';
import { detectRecurring } from './shared/detect.js';
import { parseShiftText, shiftText, shiftStats, SHIFT_LABEL } from './shared/shifts.js';
import { classify, suggestKeyword } from './shared/classify.js';
import { normalizeMerchant, parseAmount } from './shared/parse.js';
import { categoryDocs, ruleDocs, merchantDocs, accountDocs, SETTINGS,
         CAT_VERSION, ACCOUNT_VERSION, ACCOUNT_FIXES } from './shared/seed.js';

const $ = (id) => document.getElementById(id);
const won = (n) => Number(n || 0).toLocaleString('ko-KR');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let db, auth, uid, projectId, D = null;

/** 지금 펼쳐 둔 큰 갈래. "어느 화면의 어느 거래" 별로 따로 기억한다. */
const openMain = new Map();

/** 내역에서 보고 있는 달 · 펼쳐 둔 갈래 · 고치는 중인 거래 · 찾는 말. */
let histQuery = '';
let histMonth = null;
let histOpen = null;
let editTxn = null;

const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

/**
 * 설정에서 펼쳐 둔 칸. 새로 열면 다 접혀 있다 — 한 번 정해 놓고 잘 안 보는
 * 것들이니까. 다만 고치는 중에 저장해서 화면을 다시 그릴 때 접히면 안 된다.
 */
const openFold = new Set();

/**
 * 단축어가 두드릴 주소.
 *
 * 2세대 함수는 Cloud Run 주소를 받으므로 프로젝트 이름만으로 만들어 낼 수 없다.
 * 지금 배포된 주소를 기본값으로 두고, 바뀌면 설정에서 고친다.
 * 주소만으로는 아무것도 못 한다 — 토큰이 있어야 하고, 그마저도 넣기만 된다.
 */
const INGEST_DEFAULT = 'https://ingest-6ygn4mmscq-du.a.run.app';
const ingestUrl = () => D?.ingest?.url || INGEST_DEFAULT;

/**
 * 금액 가리기.
 *
 * 병원에서 누가 어깨너머로 보면 빚 액수가 그대로 보인다. 켜 두면 늘 흐려 있고,
 * 눈 버튼으로 잠깐 볼 수 있다. 잠깐 본 뒤에는 알아서 다시 가려진다 —
 * 확인하려고 열었다가 그대로 두고 자리를 뜨는 게 사람이다.
 */
const PEEK_SECONDS = 30;
let peekTimer = null;

const privacyOn = () => {
  try { return localStorage.getItem('privacy') === 'on'; } catch { return false; }
};

function applyMask(masked) {
  document.body.classList.toggle('masked', masked);
  const btn = $('peek');
  if (btn) btn.textContent = masked ? '👁' : '🙈';
}

function setPrivacy(on) {
  try { localStorage.setItem('privacy', on ? 'on' : 'off'); } catch { /* 사파리 비공개 모드 */ }
  clearTimeout(peekTimer);
  const btn = $('peek');
  if (btn) btn.hidden = !on;
  applyMask(on);
}

function peek() {
  clearTimeout(peekTimer);
  if (document.body.classList.contains('masked')) {
    applyMask(false);
    peekTimer = setTimeout(() => applyMask(true), PEEK_SECONDS * 1000);
  } else {
    applyMask(true);
  }
}

// 화면을 떠나면 다시 가린다. 열어 둔 채 자리를 뜨는 게 사람이다.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && privacyOn()) applyMask(true);
});

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  el.setAttribute('role', 'status');
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

function screen(html) {
  $('boot').hidden = false;
  $('app').hidden = true;
  $('boot').innerHTML = `<div>${html}</div>`;
}

// ───────────────────────────────────────────────── 시작

async function start() {
  let config;
  try {
    // Hosting 이 프로젝트 설정을 대신 내려 준다. 키를 코드에 적을 일이 없다.
    config = await fetch('/__/firebase/init.json').then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    });
  } catch {
    screen(`<h1>설정이 없어요</h1>
      <p class="muted" style="margin-top:10px;line-height:1.7">
        Firebase 콘솔 → 프로젝트 설정 → <b>내 앱</b> 에서<br>
        웹 앱(&lt;/&gt;)을 하나 추가해 주세요.<br>한 번이면 됩니다.
      </p>`);
    return;
  }

  projectId = config.projectId;
  const app = initializeApp(config);
  auth = getAuth(app);
  db = getFirestore(app);

  onAuthStateChanged(auth, async (user) => {
    if (!user) return showSignIn();
    uid = user.uid;
    try {
      await claimOwner(user);
      await seedIfEmpty();
      await syncCategories();
      await migrateDebts();
      await fixSeededAccounts();
      await refresh();
    } catch (err) {
      screen(`<h1>열지 못했어요</h1>
        <p class="muted" style="margin-top:10px;line-height:1.7">${esc(err.message)}</p>
        <button class="act ghost" style="margin-top:16px" onclick="location.reload()">다시 시도</button>`);
    }
  });
}

function showSignIn() {
  screen(`<h1>가계부</h1>
    <p class="muted" style="margin:10px 0 20px">구글 계정으로 들어갑니다</p>
    <button class="act primary" id="signin">로그인</button>`);
  $('signin').onclick = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch {
      // 사파리가 팝업을 막으면 같은 창에서 처리한다
      await signInWithRedirect(auth, provider);
    }
  };
}

/** 처음 로그인한 사람이 주인이 된다. 이미 주인이 있으면 그 사람만 들어온다. */
async function claimOwner(user) {
  const ref = doc(db, 'config/owner');
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, { uid: user.uid, email: user.email, claimedAt: new Date().toISOString() });
    return;
  }
  if (snap.data().uid !== user.uid) {
    await signOut(auth);
    throw new Error('이 가계부의 주인이 아닙니다.');
  }
}

const col = (name) => collection(db, 'users', uid, name);
const readAll = async (name) =>
  (await getDocs(col(name))).docs.map((d) => ({ id: d.id, ...d.data() }));

/** 규칙이 하나도 없으면 무엇을 읽든 전부 미분류로 떨어진다. */
async function seedIfEmpty() {
  const existing = await getDocs(query(col('categories'), limit(1)));
  if (!existing.empty) return;

  const batch = writeBatch(db);
  for (const c of categoryDocs()) batch.set(doc(col('categories'), c.id), c);
  for (const r of ruleDocs()) batch.set(doc(col('rules'), r.id), r);
  for (const m of merchantDocs()) batch.set(doc(col('merchants'), m.id), m);
  for (const a of accountDocs()) batch.set(doc(col('accounts'), a.id), a);
  batch.set(doc(db, 'users', uid, 'meta', 'settings'), SETTINGS);
  await batch.commit();
}

/**
 * 카테고리 구조가 바뀌면 맞춰 준다.
 *
 * 쓰던 사람에게는 seedIfEmpty 가 돌지 않으므로, 갈래를 새로 나눠도 반영되지
 * 않는다. 거래가 가리키는 id 는 그대로 두고 이름과 상위만 덮어쓰므로
 * 지난 기록이 길을 잃지 않는다.
 */
async function syncCategories() {
  const metaRef = doc(db, 'users', uid, 'meta', 'settings');
  const meta = await getDoc(metaRef);
  if (meta.exists() && Number(meta.data().catVersion || 0) >= CAT_VERSION) return;

  // 내가 고치거나 지운 칸까지 되돌려 놓으면 고친 의미가 없다.
  const removed = new Set(meta.data()?.removedCategories || []);
  const edited = new Set((await readAll('categories'))
    .filter((c) => c.userEdited).map((c) => c.id));

  const batch = writeBatch(db);
  for (const c of categoryDocs()) {
    if (removed.has(c.id) || edited.has(c.id)) continue;
    batch.set(doc(col('categories'), c.id), c, { merge: true });
  }
  batch.set(metaRef, { catVersion: CAT_VERSION }, { merge: true });
  await batch.commit();
}

/**
 * 빚을 따로 두던 걸 계좌로 옮긴다.
 *
 * 마이너스통장은 입출금 계좌이면서 빚이다. 따로 두니 어디에 넣을지 애매했고,
 * 양쪽에 넣으면 두 번 세어졌다. 한 번만 옮기고 끝낸다.
 */
/**
 * 내가 잘못 넣은 기본값을 바로잡는다.
 *
 * 카드 결제일을 5일로 seed 해 뒀는데 10일이었다. 이미 쓰고 있는 사람에게는
 * seed 가 다시 돌지 않으므로 여기서 고친다. 쓰는 사람이 직접 고쳐 둔 값은
 * 건드리지 않는다 — 내가 틀렸다고 남의 답까지 지울 이유는 없다.
 */
async function fixSeededAccounts() {
  const metaRef = doc(db, 'users', uid, 'meta', 'settings');
  const meta = await getDoc(metaRef);
  if (Number(meta.data()?.accountVersion || 0) >= ACCOUNT_VERSION) return;

  const have = await readAll('accounts');
  const ops = [];
  for (const [id, patch, onlyIf] of ACCOUNT_FIXES) {
    const row = have.find((a) => a.id === id);
    if (!row) continue;
    const untouched = Object.entries(onlyIf)
      .every(([k, v]) => String(row[k] ?? '') === String(v));
    if (!untouched) continue;
    ops.push((b) => b.set(doc(col('accounts'), id), patch, { merge: true }));
  }
  ops.push((b) => b.set(metaRef, { accountVersion: ACCOUNT_VERSION }, { merge: true }));
  await commitAll(ops);
}

async function migrateDebts() {
  const old = await readAll('debts');
  if (!old.length) return;

  const ops = old.map((d) => (b) => {
    // 이름에 마이너스통장이 들어 있으면 입출금 계좌로, 아니면 대출로 본다
    const minus = /마이너스|마통|한도/.test(String(d.name || ''));
    b.set(doc(col('accounts'), `acc_${d.id}`), {
      id: `acc_${d.id}`, name: d.name,
      type: minus ? 'checking' : 'loan',
      balance: minus ? -Math.abs(Number(d.balance) || 0) : Math.abs(Number(d.balance) || 0),
      rate: Number(d.rate) || 0,
      billingDay: Number(d.billingDay) || null,
      cardType: '', issuer: '', payFromId: '', linkedAccountId: '',
      creditLimit: 0, balanceAt: new Date().toISOString(), active: true,
    }, { merge: true });
  });
  await commitAll([...ops, ...old.map((d) => (b) => b.delete(doc(col('debts'), d.id)))]);
}

async function refresh() {
  const [categories, rules, merchants, accounts, recurring, settlements,
         txns, raw, settingsSnap, shiftSnap] =
    await Promise.all([
      readAll('categories'), readAll('rules'), readAll('merchants'), readAll('accounts'),
      readAll('recurring'), readAll('settlements'),
      getDocs(query(col('txns'), orderBy('occurredAt', 'desc'), limit(500)))
        .then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))),
      getDocs(query(col('raw'), orderBy('receivedAt', 'desc'), limit(100)))
        .then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))),
      getDoc(doc(db, 'users', uid, 'meta', 'settings')),
      getDoc(doc(db, 'users', uid, 'meta', 'shifts')),
    ]);

  const settings = settingsSnap.exists() ? settingsSnap.data() : { ...SETTINGS };
  const ingestSnap = await getDoc(doc(db, 'config/ingest')).catch(() => null);
  const ingest = ingestSnap?.exists() ? ingestSnap.data() : {};
  const shifts = shiftSnap.exists() ? (shiftSnap.data().days || {}) : {};
  D = { categories, rules, merchants, accounts, recurring, settlements,
        txns, raw, settings, ingest, shifts };
  D.ledger = ledger({ transactions: txns, recurring, settlements, accounts,
                      categories, raw, settings });

  $('boot').hidden = true;
  $('app').hidden = false;
  setPrivacy(privacyOn());
  render();

  // 확실한 취소는 묻지 않고 맞문다. 애매한 것만 정리 탭으로 간다.
  await autoOffset();
}

/**
 * 취소 문자를 원래 결제와 맞물린다.
 *
 * 취소가 지출 한 건으로 더 쌓이면 쓴 적 없는 돈이 통계에 남고 카드값 예상도
 * 틀어진다. 같은 카드 · 같은 금액 · 가까운 날짜에 후보가 하나뿐일 때만
 * 자동으로 처리한다. 같은 가게에서 같은 금액을 두 번 긁는 일은 흔해서,
 * 엉뚱한 쪽을 지우면 찾기가 더 어려워진다.
 */
async function autoOffset() {
  const open = openCancels(D.txns);
  if (!open.length) return;

  const ops = [];
  let done = 0;
  for (const c of open) {
    const { match, confident } = findOriginal(c, D.txns);
    if (!match || !confident) continue;
    ops.push((b) => b.update(doc(col('txns'), match.id), voidPatch(c)));
    ops.push((b) => b.update(doc(col('txns'), c.id), settledPatch(match)));
    done++;
  }
  if (!done) return;
  await commitAll(ops);
  await refresh();
  toast(`취소 ${done}건을 원래 결제와 맞물렸어요`);
}

// ───────────────────────────────────────────────── 그리기

function render() {
  const L = D.ledger;
  $('monthLabel').textContent = `${L.month} · ${D.settings.cycleStartDay || 1}일 시작`;

  const waiting = L.inbox.pending + L.inbox.unparsed + openCancels(D.txns).length;
  $('badge').hidden = !waiting;
  $('badge').textContent = waiting > 99 ? '99+' : waiting;

  renderHome();
  renderHistory();
  renderInbox();
  renderFixed();
  renderSetup();
  syncAccountForm();
  syncGoalForm();
  renderTagList();
}

/** 쓴 적 있는 태그를 자동완성으로 띄운다. 같은 걸 두 가지로 적으면 묶이지 않는다. */
function renderTagList() {
  let list = $('tagList');
  if (!list) {
    list = document.createElement('datalist');
    list.id = 'tagList';
    document.body.appendChild(list);
  }
  list.innerHTML = knownTags(D.txns)
    .map((t) => `<option value="${esc(t.name)}">`).join('');
}

// 미분류는 늘 맨 뒤다. 새로 만든 갈래가 그 뒤로 가면 어색하다.
const last = (c) => (c.id === 'cat_unknown' ? 1 : 0);
const byOrder = (a, b) => last(a) - last(b) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
const expenseCats = () => D.categories
  .filter((c) => c.kind === 'expense' && !c.hidden).sort(byOrder);
const mainCats = () => expenseCats().filter((c) => !c.parentId);
const subCats = (parentId) => expenseCats().filter((c) => c.parentId === parentId);
const catName = (id) => D.categories.find((c) => c.id === id)?.name ?? id;
const catIcon = (id) => D.categories.find((c) => c.id === id)?.icon ?? '';

/** 내려받는 목록도 두 단계로. 스무 칸을 평평하게 늘어놓으면 고를 수가 없다. */
function catOptions(selected = '') {
  const opt = (c, label) =>
    `<option value="${c.id}"${c.id === selected ? ' selected' : ''}>${esc(label ?? c.name)}</option>`;
  let h = `<option value=""${selected ? '' : ' selected'}>고르지 않음</option>`;
  for (const m of mainCats()) {
    const kids = subCats(m.id);
    if (!kids.length) { h += opt(m); continue; }
    h += `<optgroup label="${esc(m.name)}">${opt(m, `${m.name} 전체`)}`
       + kids.map((c) => opt(c)).join('') + '</optgroup>';
  }
  return h;
}

function flowRow(name, amount, color, sign) {
  return `<div class="row" style="padding:5px 0">
    <span class="grow" style="font-size:13.5px;color:var(--ink2)">${name}</span>
    <span class="num" style="font-size:13.5px;font-weight:600;color:${color}">${sign} ${won(amount)}</span>
  </div>`;
}

/**
 * 홈.
 *
 * 매일 보는 건 이번 달이지 빚 총액이 아니다. 빚 숫자를 42px 로 맨 위에 두면
 * 어깨너머로 그대로 보이고, 다 갚고 나면 화면이 텅 빈다. 순서를 뒤집었다 —
 * 이번 달이 먼저, 목표는 그 아래.
 */
function renderHome() {
  const { debt, planned, budget, assets, inbox, goal, cards } = D.ledger;
  const spent = monthSpending(histData(), D.ledger.month);
  const spentTotal = sumCounted(spent);
  const prev = sameSpanLastMonth(histData(), D.ledger.month);
  const run = pace(spentTotal, D.ledger.month, D.settings.cycleStartDay);
  let h = '';

  // ── 이번 달 ────────────────────────────────────────────
  h += `<div class="card">
    <div class="row"><span class="lbl grow">이 달에 쓴 돈</span>
      <span class="muted">${run.dayOf}/${run.days}일</span></div>
    <div class="big num" style="font-size:38px;color:var(--spend);margin:10px 0 ${budget.limit ? 12 : 8}px">₩${won(spentTotal)}</div>`;

  if (budget.limit) {
    h += `<div class="bar"><i style="width:${Math.min(100, budget.usedPct)}%;background:var(--spend)"></i></div>
      <div class="row" style="margin-top:9px">
        <span class="grow" style="font-size:13px;color:var(--ink2)">오늘 쓸 수 있는 돈</span>
        <span class="num" style="font-size:19px;font-weight:700;color:var(--blue)">₩${won(budget.perDay)}</span></div>
      <div class="muted">예산 ₩<span class="num">${won(budget.limit)}</span> 중 ${budget.usedPct}% · 남은 ${budget.daysLeft}일</div>`;
  }

  if (prev.total > 0) {
    const gap = spentTotal - prev.total;
    const pct = Math.round((gap / prev.total) * 100);
    h += `<div class="note ${gap > 0 ? 'warn' : 'ok'}" style="margin:12px 0 0">
      ${gap > 0 ? '지난달 같은 기간보다' : '지난달 같은 기간보다'}
      <b class="num">₩${won(Math.abs(gap))}</b> ${gap > 0 ? '더' : '덜'} 쓰고 있어요 (${pct > 0 ? '+' : ''}${pct}%).<br>
      이 속도면 이 달은 <b class="num">₩${won(run.projected)}</b>${
        budget.limit ? ` — 예산보다 <b class="num">₩${won(Math.abs(run.projected - budget.limit))}</b> ${run.projected > budget.limit ? '넘어요' : '적어요'}` : ''}.</div>`;
  } else if (!budget.limit) {
    h += `<div class="muted" style="margin-top:4px">설정에서 생활비 예산을 잡으면
      <b>오늘 쓸 수 있는 돈</b>이 여기 나와요.</div>`;
  }

  h += `<div class="hr"></div>
    <button type="button" class="act tint" style="width:100%" data-tab="history">
      어디에 썼는지 보기 →</button></div>`;

  // ── 다음 카드값 ─────────────────────────────────────────
  if (cards.total) {
    h += `<div class="card">
      <div class="row"><span class="lbl grow">다음 카드값</span>
        <span class="muted">${cards.items[0].daysLeft}일 뒤</span></div>
      <div class="big num" style="font-size:30px;color:var(--spend);margin:10px 0 12px">₩${won(cards.total)}</div>`;
    for (const b of cards.items) {
      h += `<div class="row" style="padding:6px 0">
        <span class="grow"><span style="font-size:13px;font-weight:600">${esc(b.name)}</span><br>
          <span class="muted">${dateLabel(b.payAt)} 출금${b.shifted ? ' (쉬는 날이라 밀림)' : ''}${
            b.carried ? ` · 리볼빙 <span class="num">${won(b.carried)}</span> 포함` : ''}</span></span>
        <span class="num" style="font-size:14px;font-weight:600">${won(b.total)}</span></div>`;
    }
    h += `<div class="muted" style="margin-top:8px">${esc(dateLabel(cards.items[0].from))} 이후 긁은 것부터 셉니다.</div></div>`;
  }

  // ── 목표 ───────────────────────────────────────────────
  h += renderGoal(goal, debt, planned);

  // ── 순자산 ─────────────────────────────────────────────
  if (assets.total || debt.total) {
    h += `<div class="card">
      <div class="row"><span class="lbl grow">순자산</span><span class="muted">가진 돈 − 빚</span></div>
      <div class="big num" style="font-size:28px;margin:9px 0 12px;color:${assets.net >= 0 ? 'var(--ink)' : 'var(--spend)'}">
        ${assets.net < 0 ? '−₩' + won(-assets.net) : '₩' + won(assets.net)}</div>`;
    assets.items.filter((a) => a.balance).forEach((a) => {
      h += `<div class="row" style="padding:5px 0">
        <span class="grow" style="font-size:13px;color:var(--ink2)">${esc(a.name)}</span>
        <span class="num" style="font-size:13.5px;font-weight:600;color:var(--blue)">${won(a.balance)}</span></div>`;
    });
    if (debt.total) {
      h += `<div class="row" style="padding:5px 0">
        <span class="grow" style="font-size:13px;color:var(--ink2)">빚</span>
        <span class="num" style="font-size:13.5px;font-weight:600;color:var(--spend)">− ${won(debt.total)}</span></div>`;
    }
    h += '</div>';
  }

  // ── 이번 달 계산 ────────────────────────────────────────
  h += `<div class="card"><div class="lbl" style="margin-bottom:11px">이번 달 계산</div>
    ${flowRow('수입', planned.income, 'var(--blue)', '+')}
    ${flowRow('고정비', planned.fixed, 'var(--spend)', '−')}
    ${flowRow('생활비 예산', planned.variableBudget, 'var(--spend)', '−')}
    <div class="hr"></div>
    <div class="row"><span class="grow" style="font-size:14px;font-weight:600">남는 돈</span>
      <span class="big num" style="font-size:22px;color:${planned.available >= 0 ? 'var(--blue)' : 'var(--spend)'}">${won(planned.available)}</span>
    </div></div>`;

  const waiting = inbox.pending + inbox.unparsed + openCancels(D.txns).length;
  if (waiting) {
    h += `<button type="button" class="note warn" data-tab="inbox">
      정리할 게 <b>${waiting}건</b> 있어요 — 분류 안 된 결제 ${inbox.pending}건, 못 읽은 문자 ${inbox.unparsed}건<br>
      <span style="text-decoration:underline">정리하러 가기</span></button>`;
  }

  $('home').innerHTML = h;
}

const GOAL_WORD = {
  payoff: { verb: '갚음', left: '남은 빚', none: '갚을 빚이 없어요' },
  save: { verb: '모음', left: '더 모아야 할 돈', none: '목표를 다 채웠어요' },
};

/**
 * 갚는 것도 모으는 것도 "지금 얼마이고 어디까지 가야 하는가"라는 같은 모양이다.
 * 빚을 다 갚으면 다음 목표로 넘어갈 수 있어야 홈이 안 빈다.
 */
function renderGoal(goal, debt, planned) {
  if (goal.kind === 'keep') {
    return `<div class="card"><div class="empty">목표를 아직 안 정했어요.<br>
      설정에서 <b>빚 갚기</b>나 <b>모으기</b>를 정하면<br>여기에 진행과 언제 끝나는지가 나와요.</div></div>`;
  }
  const w = GOAL_WORD[goal.kind];
  let h = `<div class="card">
    <div class="row"><span class="lbl grow">${esc(goal.name)}</span>
      ${goal.daysToTarget !== null ? `<span class="muted">목표까지 D-${Math.max(0, goal.daysToTarget)}</span>` : ''}</div>`;

  if (goal.done) {
    h += `<div class="big" style="font-size:24px;margin:12px 0 8px;color:var(--blue)">${w.none} 🎉</div>
      <div class="muted">설정에서 다음 목표를 정해 보세요.</div></div>`;
    return h;
  }

  h += `<div class="row" style="margin:10px 0 12px">
      <span class="grow" style="font-size:12.5px;color:var(--ink2)">${w.left}</span>
      <span class="big num" style="font-size:30px;color:${goal.kind === 'payoff' ? 'var(--spend)' : 'var(--blue)'}">₩${won(goal.remaining)}</span></div>
    <div class="bar"><i style="width:${Math.min(100, Math.max(2, goal.pct))}%;background:var(--blue)"></i></div>
    <div class="muted" style="margin-top:7px">
      <b style="color:var(--blue)">${goal.pct}% ${w.verb}</b> · 시작 ₩<span class="num">${won(goal.start)}</span>${
        goal.kind === 'save' ? ` · 목표 ₩<span class="num">${won(goal.target)}</span>` : ''}</div>`;

  if (goal.kind === 'payoff' && debt.items.length) {
    h += '<div class="hr"></div>';
    debt.items.forEach((d, i) => {
      h += `<div class="row" style="padding:7px 0">
        <span style="width:3px;height:26px;border-radius:2px;background:${i === 0 ? 'var(--spend)' : '#CBD5E1'}"></span>
        <span class="grow"><span style="font-size:13.5px;font-weight:600">${esc(d.name)}</span><br>
          <span class="muted">연 ${Number(d.rate) || 0}%${i === 0 && debt.items.length > 1 ? ' · 먼저 갚기' : ''}</span></span>
        <span class="num" style="font-size:15px;font-weight:600">${won(d.amount)}</span></div>`;
    });
  }
  h += '</div>';

  if (!planned.income) {
    h += `<div class="note warn">매달 들어오는 돈을 아직 안 넣었어요.<br>설정에 넣으면 <b>언제 끝나는지</b>가 나옵니다.</div>`;
  } else if (goal.paceMonths === null) {
    h += `<div class="note warn"><b>지금은 여력이 없어요.</b><br>
      고정비나 생활비 예산을 줄이지 않으면 제자리예요.</div>`;
  } else if (goal.needPerMonth === null) {
    h += `<div class="note ok">이 속도면 <b>${goal.paceMonths}개월</b> 걸려요.
      설정에서 목표 날짜를 정하면 속도가 맞는지 알려드릴게요.</div>`;
  } else if (goal.onTrack) {
    h += `<div class="note ok"><b>이 속도면 ${goal.paceMonths}개월 — 목표 안에 끝나요.</b><br>
      매달 ₩<span class="num">${won(goal.needPerMonth)}</span> 필요, 여력 ₩<span class="num">${won(planned.available)}</span>.</div>`;
  } else {
    h += `<div class="note warn"><b>이 속도면 ${goal.paceMonths}개월 — 목표보다 늦어요.</b><br>
      목표 안에 끝내려면 매달 <b class="num">₩${won(goal.needPerMonth)}</b>이 필요해요.
      지금 여력은 <b class="num">₩${won(planned.available)}</b>, <b class="num">₩${won(goal.shortfall)}</b> 모자랍니다.</div>`;
  }
  return h;
}

// ───────────────────────────────────────────────── 내역

const histData = () =>
  ({ transactions: D.txns, settlements: D.settlements, settings: D.settings });

const sumCounted = (rows) => rows.reduce((s, r) => s + (r.counted ? r.net : 0), 0);

const dateLabel = (d) => `${d.getMonth() + 1}월 ${d.getDate()}일`;

/**
 * 달마다 얼마 썼나.
 *
 * 한 줄기뿐이라 색은 하나다 — 막대가 길수록 진하게 칠하면 길이가 말하는 걸
 * 색으로 한 번 더 말하는 셈이고, 그러느라 색이라는 칸을 버리게 된다.
 * 이번 달만 빗금으로 가른다. 아직 안 끝났으니까.
 *
 * 숫자는 골라서 붙인다. 막대마다 숫자를 달면 아무도 안 읽는다.
 */
function renderTrend(months) {
  if (months.length < 2) return '';
  const limit = Number(D.settings.variableBudget || 0);
  const top = Math.max(limit, ...months.map((m) => Math.max(m.total, m.projected || 0))) || 1;
  const H = 122;
  const y = (v) => Math.round((v / top) * H);

  const most = months.reduce((a, b) => (b.total > a.total ? b : a), months[0]);
  const worth = (m) => m.total > 0 && (m.current || m === most);

  let bars = '';
  for (const m of months) {
    const h = m.total > 0 ? Math.max(4, y(m.total)) : 0;
    // 이 속도로 갔을 때의 끝값. 칠한 막대와 2px 띄워 둘이 붙어 보이지 않게 한다.
    const cap = m.current && m.projected > m.total ? Math.max(4, y(m.projected) - h - 2) : 0;

    bars += `<button type="button" class="tb${m.current ? ' now' : ''}" data-trend="${m.month}"
      aria-label="${esc(m.label)} ${won(m.total)}원">
      <span class="tb-stack">
        ${h ? `<i class="tb-b" style="height:${h}px"></i>` : '<i class="tb-z"></i>'}
        ${cap ? `<i class="tb-p" style="height:${cap}px;bottom:${h + 2}px"></i>` : ''}
        ${/* 숫자는 실제로 쓴 만큼의 높이에 붙인다. 옅은 칸 꼭대기에 붙이면
             아직 쓰지도 않은 금액을 쓴 것처럼 읽힌다. */''}
        ${worth(m) ? `<span class="tb-v num" style="bottom:${h + 5}px">${
          won(Math.round(m.total / 1000))}</span>` : ''}
      </span>
      <span class="tb-l">${esc(m.label)}</span></button>`;
  }

  return `<div class="card">
    <div class="row"><span class="lbl grow">달마다 쓴 돈</span>
      <span class="muted">천 원 단위</span></div>
    <div class="trend" style="--h:${H}px">
      ${limit ? `<div class="tb-limit" style="bottom:${y(limit) + 17}px">
        <span>예산 <b class="num">${won(Math.round(limit / 1000))}</b></span></div>` : ''}
      ${bars}
    </div>
    ${months.at(-1).current ? `<div class="muted" style="margin-top:12px">
      옅은 칸은 <b>이 속도로 갔을 때</b>의 이달 끝값이에요. 아직 안 끝난 달이라 그냥 견주면 낮게 보입니다.</div>` : ''}
  </div>`;
}

function renderHistory() {
  const box = `<div class="card" style="padding:12px 14px">
    <input id="histSearch" type="search" autocomplete="off" placeholder="가게 · 카테고리 · 금액 · 태그로 찾기"
      value="${esc(histQuery)}" style="min-height:42px"></div>`;

  // 찾는 중에는 달을 넘나들지 않는다. "그때 그 병원"이 몇 월인지 알면 안 찾는다.
  if (histQuery.trim()) {
    const hits = search(histQuery, { transactions: D.txns, categories: D.categories });
    const total = hits.reduce((sum, t) => sum + (t.type === 'expense' ? Number(t.amount || 0) : 0), 0);
    let f = box;
    if (!hits.length) {
      f += `<div class="card"><div class="empty">「${esc(histQuery)}」로 찾은 게 없어요.<br>
        이름 일부만 쳐도 돼요.</div></div>`;
    } else {
      f += `<div class="card">
        <div class="row"><span class="lbl grow">찾은 것 ${hits.length}건</span>
          <span class="num" style="font-size:15px;font-weight:700">${won(total)}</span></div></div>
        <div class="card" style="padding:4px 16px">${hits.slice(0, 80).map(txRow).join('')}</div>`;
      if (hits.length > 80) f += `<div class="muted" style="text-align:center;margin-top:8px">앞 80건만 보여요</div>`;
    }
    $('history').innerHTML = f;
    return;
  }

  const month = histMonth || D.ledger.month;
  const [y, m] = month.split('-');
  const rows = monthSpending(histData(), month);
  const total = sumCounted(rows);
  const b = breakdown(rows, D.categories);
  const atNow = month >= monthKey();

  // 달 전체와 견주면 달 초엔 늘 "덜 썼다"가 되고 말일에 뒤집힌다.
  // 9월 19일까지 쓴 돈은 8월 19일까지 쓴 돈과 견줘야 말이 된다.
  const prev = sameSpanLastMonth(histData(), month);
  let diff = '';
  if (prev.total > 0) {
    const pct = Math.round(((total - prev.total) / prev.total) * 100);
    const span = prev.whole ? '지난달' : `지난달 같은 기간`;
    diff = ` · ${span}(₩<span class="num">${won(prev.total)}</span>)보다 <b class="num" style="color:${pct > 0 ? 'var(--spend)' : 'var(--blue)'}">`
         + `${pct > 0 ? '+' : pct < 0 ? '−' : '±'}${Math.abs(pct)}%</b>`;
  }

  let h = box + `<div class="card">
    <div class="row">
      <button type="button" class="act ghost small" data-month="-1" aria-label="지난달">←</button>
      <div class="grow" style="text-align:center">
        <div style="font-size:15px;font-weight:600">${Number(y)}년 ${Number(m)}월</div>
        <div class="muted">${D.settings.cycleStartDay || 1}일부터 한 달</div></div>
      <button type="button" class="act ghost small" data-month="1" aria-label="다음 달"
        ${atNow ? 'disabled style="opacity:.32"' : ''}>→</button>
    </div>
    <div class="hr"></div>
    <div class="lbl">이 달에 쓴 돈</div>
    <div class="big num" style="font-size:40px;color:var(--spend);margin:10px 0 7px">₩${won(total)}</div>
    <div class="muted">${rows.length}건${diff}</div>
  </div>`;

  if (!rows.length) {
    h += `<div class="card"><div class="empty">이 달엔 쓴 기록이 없어요.<br>
      카드 문자가 들어오면 여기에 쌓입니다.</div></div>`;
    $('history').innerHTML = h;
    return;
  }

  h += renderTrend(trend(histData(), 6));
  h += renderShifts(month);

  const limits = categoryBudgets(
    Object.fromEntries(b.items.flatMap((i) => [[i.id, i.amount], ...i.subs.map((s) => [s.id, 0])])),
    D.settings, D.categories);
  const limitOf = (id) => limits.items.find((i) => i.id === id);

  const top = b.items[0]?.amount || 1;
  h += `<div class="card">
    <div class="lbl">어디에 썼나</div>
    <div class="muted" style="margin:4px 0 6px">큰 갈래를 누르면 그 안이 열려요.${
      limits.withLimit.length ? ' 예산을 잡은 갈래는 예산에 견줘 보여줍니다.' : ''}</div>`;
  for (const it of b.items) {
    const open = histOpen === it.id;
    const cap = limitOf(it.id);
    h += `<button type="button" class="brk" data-open="${it.id}" aria-expanded="${open}">
      <span class="brk-ico">${esc(catIcon(it.id))}</span>
      <span class="grow">
        <span class="brk-name">${esc(catName(it.id))}
          <span class="muted" style="font-weight:400">${it.count}건${
            cap?.limit ? ` · 예산 <span class="num">${won(cap.limit)}</span>` : ''}</span></span>
        <span class="bar"><i style="width:${cap?.limit
          ? Math.min(100, Math.max(3, cap.pct))
          : Math.max(3, Math.round((it.amount / top) * 100))}%;background:${
          cap?.over ? 'var(--spend)' : 'var(--blue)'}"></i></span>
      </span>
      <span class="brk-amt num">${won(it.amount)}<br><span class="muted"${
        cap?.over ? ' style="color:var(--spend);font-weight:700"' : ''}>${
        /* 한 칸에 두 뜻을 섞으면 안 된다 — 43% 가 예산의 43% 인지 전체의 43% 인지
           알 길이 없다. 막대가 무엇에 견준 것인지 글자로 말해 준다. */''}${
        cap?.limit ? `${cap.over ? '예산 넘음' : `예산 ${cap.pct}%`}` : `비중 ${it.pct}%`}</span></span>
    </button>`;
    if (!open) continue;
    for (const sub of it.subs) {
      h += `<div class="brk-sub"><span class="grow">${esc(catIcon(sub.id))} ${esc(catName(sub.id))}
        <span class="muted">${sub.count}건</span></span>
        <span class="num" style="font-weight:600">${won(sub.amount)}</span></div>`;
    }
    if (!it.subs.length) {
      h += `<div class="brk-sub"><span class="muted">더 나눌 갈래가 없어요</span></div>`;
    }
  }
  h += '</div>';

  const days = new Map();
  for (const r of rows) {
    const key = String(r.occurredAt).slice(0, 10);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(r);
  }

  h += `<div class="lbl" style="margin:20px 2px 0">쓴 내역 · 누르면 고칠 수 있어요</div>`;
  for (const [key, list] of days) {
    const d = new Date(`${key}T00:00:00`);
    h += `<div class="day">
      <span class="day-date">${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAY[d.getDay()]})</span>
      <span class="day-sum">${won(sumCounted(list))}</span></div>
      <div class="card" style="padding:4px 16px">${list.map(txRow).join('')}</div>`;
  }

  $('history').innerHTML = h;
}

/**
 * 근무별 지출.
 *
 * 3교대는 하루의 모양이 매일 다르다. 나이트 끝나고 새벽에 쓰는 돈과 오프 날
 * 쓰는 돈은 성격이 완전히 다른데, 달력으로만 보면 둘 다 그냥 "9월 19일"이다.
 * 이건 시중 가계부가 못 하는 일이다 — 근무표를 모르니까.
 */
function renderShifts(month) {
  const has = Object.keys(D.shifts).some((k) => k.startsWith(month));
  if (!has) {
    // 안 넣었으면 조르지 않는다. 한 번만 알려 주고 만다.
    return Object.keys(D.shifts).length ? '' : `<button type="button" class="note ok"
      data-tab="setup">근무표를 넣으면 <b>근무별로 얼마 쓰는지</b> 볼 수 있어요 —
      나이트 다음 날 유독 많이 쓰는지 같은 것. 설정 → 근무표.</button>`;
  }

  const rows = monthSpending(histData(), month);
  const only = Object.fromEntries(Object.entries(D.shifts).filter(([k]) => k.startsWith(month)));
  const s = shiftStats({ transactions: rows, shifts: only, settlements: D.settlements });
  if (!s.items.length) return '';

  const top = Math.max(...s.items.map((i) => i.perDay), s.afterNight?.perDay || 0) || 1;
  const line = (i, faint) => `<div class="brk" style="cursor:default">
    <span class="grow">
      <span class="brk-name">${esc(i.label)}
        <span class="muted" style="font-weight:400">${i.days}일</span></span>
      <span class="bar"><i style="width:${Math.max(3, Math.round((i.perDay / top) * 100))}%;
        background:var(--blue)${faint ? ';opacity:.45' : ''}"></i></span>
    </span>
    <span class="brk-amt num">${won(i.perDay)}<br><span class="muted">하루</span></span></div>`;

  return `<div class="card">
    <div class="row"><span class="lbl grow">근무별로 하루에</span>
      <span class="muted">${s.days}일치</span></div>
    <div class="muted" style="margin:4px 0 4px">총액이 아니라 하루 평균이에요.
      오프가 많으면 총액은 당연히 커지니까요.</div>
    ${s.items.map((i) => line(i)).join('')}
    ${s.afterNight ? line(s.afterNight, true) : ''}
    ${s.gap > 5000 ? `<div class="note ok" style="margin:12px 0 0">
      <b>${esc(s.items[0].label)}</b>에는 <b>${esc(s.items.at(-1).label)}</b>보다
      하루 <b class="num">${won(s.gap)}</b>씩 더 써요.
      ${esc(s.items[0].label)}가 이 달에 ${s.items[0].days}일이니
      <b class="num">${won(s.gap * s.items[0].days)}</b> 차이예요.</div>` : ''}
  </div>`;
}

function txRow(r) {
  const open = editTxn === r.id;
  const cat = r.categoryId ? `${catIcon(r.categoryId)} ${catName(r.categoryId)}` : '❓ 아직 안 정함';
  const note = [cat, r.cardName, r.counted ? '' : '예산에서 뺌',
                ...(r.tags || []).map((t) => `#${t}`), r.memo].filter(Boolean).join(' · ');

  let h = `<button type="button" class="tx${r.counted ? '' : ' off'}"
    data-tx="${r.id}" aria-expanded="${open}">
    <span class="grow">
      <span class="tx-name">${esc(r.merchantRaw || '(가게 이름 없음)')}</span>
      <span class="muted">${esc(note)}</span></span>
    <span class="tx-amt">${won(r.net)}</span></button>`;
  return open ? h + txEdit(r) : h;
}

/**
 * 거래 하나를 그 자리에서 고친다.
 *
 * 잘못 분류된 건을 찾아 놓고 고칠 곳이 딴 데 있으면 아무도 안 고친다.
 * 규칙까지 함께 고칠 수 있어야 같은 실수가 다음 달에 되풀이되지 않는다.
 */
function txEdit(r) {
  const hint = suggestKeyword(r.merchantRaw, { rules: D.rules, transactions: D.txns });
  const scopes = scopeOptions(r.merchantRaw, hint);
  const same = sweepCount(r, scopes[0]);

  let h = `<div class="edit">
    <div class="lbl" style="margin-bottom:9px">카테고리 바꾸기</div>
    ${renderPicker(r, null, 'hist', r.categoryId || '')}
    <div class="field" style="margin:13px 0 0"><label>다음부터 이 가게는</label>
      <select data-scope="${r.id}">
        ${scopes.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
      </select></div>
    <label class="check" data-also style="margin:11px 0 0" ${same ? '' : 'hidden'}>
      <input type="checkbox" data-alsopast>
      <span>이미 분류된 지난 <b data-alsocount>${same}</b>건도 같이 바꾸기</span></label>`;

  h += `<div class="hr"></div>
    <form data-txn="${r.id}">
      <div class="fields">
        <div class="field"><label>금액</label>
          <input name="amount" inputmode="numeric" value="${won(r.amount)}"></div>
        <div class="field"><label>가게 이름</label>
          <input name="merchantRaw" value="${esc(r.merchantRaw || '')}"></div></div>
      <div class="field"><label>태그 <span class="muted" style="font-weight:400">없어도 돼요</span></label>
        <input name="tags" value="${esc((r.tags || []).join(', '))}"
          placeholder="제주여행, 모임" list="tagList">
        <div class="muted" style="margin-top:6px">쉼표로 나눠요. 카테고리는 하나만 달 수 있지만 태그는 여럿 달 수 있어요.</div></div>
      <div class="field"><label>메모 <span class="muted" style="font-weight:400">없어도 돼요</span></label>
        <input name="memo" value="${esc(r.memo || '')}" placeholder="누구랑, 왜" maxlength="60"></div>
      <label class="check"><input type="checkbox" name="excludeFromBudget"
        ${r.excludeFromBudget ? 'checked' : ''}> 이 건은 예산에서 빼기 (더치페이·환불 등)</label>
      <div style="display:flex;gap:7px">
        <button type="submit" class="act primary" style="flex:1">저장</button>
        <button type="button" class="act danger" style="min-height:44px;font-size:13.5px"
          data-del="txns:${r.id}">삭제</button></div>
    </form></div>`;
  return h;
}

/**
 * 자동 분류 규칙을 눈에 보이게 하고 고칠 수 있게 한다.
 *
 * 자동으로 정해지는 게 어디서 나오는지 안 보이면, 틀렸을 때 고칠 데가 없고
 * 맞았을 때도 믿을 수가 없다.
 */
function renderRules() {
  const mine = [
    ...D.merchants
      .filter((m) => m.defaultCategoryId && !m.isPassthrough && !m.alwaysAsk)
      .map((m) => ({ key: m.normalizedName, kind: 'merchants', id: m.id,
                     label: m.displayName || m.normalizedName,
                     how: '이 가게만', cat: m.defaultCategoryId })),
    ...D.rules
      .filter((r) => r.source === 'learned')
      .map((r) => ({ key: r.pattern, kind: 'rules', id: r.id, label: r.pattern,
                     how: `이름에 「${r.pattern}」 포함`, cat: r.categoryId })),
  ];
  const builtin = D.rules
    .filter((r) => r.source !== 'learned')
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
    .map((r) => ({ key: r.pattern, kind: 'rules', id: r.id, label: r.pattern,
                   how: `이름에 「${r.pattern}」 포함`, cat: r.categoryId }));
  const pass = D.merchants.filter((m) => m.isPassthrough || m.alwaysAsk);

  const row = (x) => `<div class="item" data-rulekey="${esc(x.key)}">
    <span class="grow"><span style="font-size:13px;font-weight:600">${esc(x.label)}</span><br>
      <span class="muted">${esc(x.how)}</span></span>
    <span class="acts">
      <select class="cat-sel" data-recat="${x.kind}:${x.id}">${catOptions(x.cat)}</select>
      <button type="button" class="act danger" data-del="${x.kind}:${x.id}">삭제</button></span></div>`;

  let h = `<div class="muted" style="margin-bottom:12px">문자가 오면 이 목록을 훑어 카테고리를 정해요.
      <b>내가 정한 것</b>을 먼저 보고, 거기 없으면 기본 규칙을 봅니다.
      잘못 정해지는 게 있으면 여기서 바꾸거나 지우세요.</div>
    <input id="ruleFilter" placeholder="가게 이름으로 찾기" autocomplete="off">
    <div class="lbl" style="margin:16px 0 0">내가 정한 것 · ${mine.length}개</div>`;

  h += mine.length ? mine.map(row).join('')
    : `<div class="empty">아직 없어요.<br>정리 화면이나 내역에서 카테고리를 고르면<br>여기에 쌓입니다.</div>`;

  h += `<details class="mini" style="margin-top:8px">
    <summary>처음부터 들어 있던 규칙 ${builtin.length}개</summary>
    ${builtin.map(row).join('')}
    <div class="lbl" style="margin:16px 0 0">이름을 못 믿는 곳 · ${pass.length}개</div>
    <div class="muted" style="margin-bottom:2px">간편결제는 가게 이름이 대행사로 찍혀요.
      이런 곳은 자동으로 정하지 않고 물어봅니다.</div>
    ${pass.map((m) => `<div class="item" data-rulekey="${esc(m.normalizedName)}">
      <span class="grow" style="font-size:13px;font-weight:600">${esc(m.displayName || m.normalizedName)}</span>
      <span class="acts"><button type="button" class="act danger"
        data-del="merchants:${m.id}">삭제</button></span></div>`).join('')}
  </details>`;
  return h;
}

function renderInbox() {
  const pending = D.txns.filter((t) => t.status === 'pendingCategory' && t.type === 'expense');
  const unparsed = D.raw.filter((r) => !r.parsedOk && !r.txnId);
  const cancels = openCancels(D.txns);
  const found = detectRecurring({ transactions: D.txns, recurring: D.recurring, settings: D.settings });
  let h = '';

  if (found.length) {
    h += `<div class="lbl" style="margin:2px 0 4px">이거 고정비 아니에요 · ${found.length}건</div>
      <div class="muted" style="margin-bottom:9px">매달 같은 곳에 같은 금액이 나가고 있어요.
      등록해 두면 빚 갚을 여력이 정확해져요.</div>`;
    for (const f of found.slice(0, 6)) {
      h += `<div class="card">
        <div class="row" style="align-items:flex-start">
          <span class="grow"><span style="font-size:15px;font-weight:600">${esc(f.name)}</span><br>
            <span class="muted">${f.months.length}달 연속 · 매월 ${f.dayOfMonth}일쯤${
              f.spread ? ` (${f.spread}일까지 밀림)` : ''}</span></span>
          <span class="big num" style="font-size:20px">${won(f.expectedAmount)}</span></div>
        <div class="muted" style="margin-top:9px">${
          f.months.map((m, i) => `${Number(m.split('-')[1])}월 <span class="num">${won(f.amounts[i])}</span>`).join(' · ')}${
          f.varies ? ' — 금액이 달마다 달라요 (평균으로 잡아요)' : ''}</div>
        <div style="display:flex;gap:7px;margin-top:13px">
          <button type="button" class="act primary" style="flex:1"
            data-addfixed="${esc(f.key)}">고정비로 등록</button>
          <button type="button" class="act ghost" data-nofixed="${esc(f.key)}">아니에요</button>
        </div></div>`;
    }
  }

  if (cancels.length) {
    h += `<div class="lbl" style="margin:2px 0 9px">어느 결제를 취소한 건가요 · ${cancels.length}건</div>`;
    for (const c of cancels) {
      const { candidates } = findOriginal(c, D.txns);
      h += `<div class="card">
        <div class="row" style="align-items:flex-start">
          <span class="grow"><span style="font-size:15px;font-weight:600">취소 — ${esc(c.merchantRaw || '가맹점 미상')}</span><br>
            <span class="muted">${esc(String(c.occurredAt).replace('T', ' ').slice(5, 16))}${c.cardName ? ' · ' + esc(c.cardName) : ''}</span></span>
          <span class="big num" style="font-size:22px">${won(c.amount)}</span></div>`;

      if (!candidates.length) {
        h += `<div class="note warn" style="margin:13px 0 0">같은 금액으로 긁은 결제를 못 찾았어요.<br>
          원래 결제가 아직 안 들어왔거나, 다른 카드일 수 있어요.</div>
          <button type="button" class="act ghost" style="width:100%;margin-top:9px"
            data-dropcancel="${c.id}">이 취소는 치우기</button></div>`;
        continue;
      }

      h += `<div class="muted" style="margin:13px 0 7px">맞물릴 결제를 골라 주세요</div>`;
      for (const o of candidates.slice(0, 5)) {
        const days = Math.round((new Date(c.occurredAt) - new Date(o.occurredAt)) / 86400000);
        h += `<button type="button" class="item" style="width:100%;text-align:left;background:none;border-top:0;border-left:0;border-right:0;cursor:pointer"
          data-offset="${c.id}:${o.id}">
          <span class="grow"><span style="font-size:13.5px;font-weight:600">${esc(o.merchantRaw || '(이름 없음)')}</span><br>
            <span class="muted">${esc(String(o.occurredAt).slice(5, 10))} · ${days === 0 ? '같은 날' : `${days}일 전`}${o.categoryId ? ' · ' + esc(catName(o.categoryId)) : ''}</span></span>
          <span class="num" style="font-size:14px;font-weight:600">${won(o.amount)}</span></button>`;
      }
      h += `<button type="button" class="act ghost" style="width:100%;margin-top:11px"
        data-dropcancel="${c.id}">어느 것도 아니에요</button></div>`;
    }
  }

  if (!pending.length && !unparsed.length && !cancels.length && !found.length) {
    $('inbox').innerHTML = `<div class="card"><div class="empty">정리할 게 없어요.<br>분류하지 못한 결제가 생기면 여기에 쌓입니다.</div></div>`;
    return;
  }

  if (pending.length) {
    h += `<div class="lbl" style="margin:${cancels.length || found.length ? 18 : 2}px 0 9px">어디에 쓴 돈인가요 · ${pending.length}건</div>`;
    for (const t of pending) {
      const decision = classify(t.merchantRaw, {
        merchants: D.merchants, rules: D.rules, transactions: D.txns,
        location: t.lat != null ? { lat: t.lat, lon: t.lon } : null,
      });
      const hint = suggestKeyword(t.merchantRaw, { rules: D.rules, transactions: D.txns });

      h += `<div class="card">
        <div class="row" style="align-items:flex-start">
          <span class="grow"><span style="font-size:15px;font-weight:600">${esc(t.merchantRaw || '(가맹점 미상)')}</span><br>
            <span class="muted">${esc(String(t.occurredAt).replace('T', ' ').slice(5, 16))}${t.cardName ? ' · ' + esc(t.cardName) : ''}</span></span>
          <span class="big num" style="font-size:22px">${won(t.amount)}</span></div>`;

      if (decision.nearby?.samples) {
        h += `<div class="note ok" style="margin:12px 0 0;padding:9px 12px">
          전에 같은 자리에서 ${decision.nearby.samples}번 썼어요</div>`;
      }

      h += renderPicker(t, decision.nearby?.categoryId);

      h += `<div class="hr"></div>
        <div class="field" style="margin:0"><label>다음부터 이 가게는</label>
          <select data-scope="${t.id}">
          ${scopeOptions(t.merchantRaw, hint).map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
          </select></div></div>`;
    }
  }

  if (unparsed.length) {
    h += `<div class="lbl" style="margin:18px 0 9px">읽지 못한 문자 · ${unparsed.length}건</div>`;
    for (const r of unparsed) {
      h += `<form class="card" data-raw="${r.id}">
        <div class="raw">${esc(r.body)}</div>
        ${r.parseNote ? `<div class="muted" style="margin-top:8px">${esc(r.parseNote)}</div>` : ''}
        <div class="fields" style="margin-top:12px">
          <div class="field" style="margin:0"><label>금액</label>
            <input name="amount" inputmode="numeric" placeholder="9,900"></div>
          <div class="field" style="margin:0"><label>가맹점</label>
            <input name="merchant" placeholder="어디서 썼나요"></div></div>
        <div class="field"><label>카테고리</label>
          <select name="categoryId">${catOptions()}</select></div>
        <div style="display:flex;gap:7px">
          <button type="submit" class="act primary" style="flex:1">거래로 넣기</button>
          <button type="button" class="act ghost" data-ignore="${r.id}">거래 아님</button>
        </div></form>`;
    }
  }

  $('inbox').innerHTML = h;
}

/**
 * 카테고리 고르는 칸.
 *
 * 큰 갈래를 먼저 늘어놓는다. 갈래 안이 여럿이면 눌렀을 때 펼쳐지고,
 * 하나뿐이면 그 자리에서 정해진다. "배달 · 외식 · 카페"를 한 줄에 늘어놓는 것보다
 * "식비"를 먼저 고르는 편이 생각이 적다.
 */
function renderPicker(t, hintedId, ns = 'inbox', currentId = '') {
  const key = `${ns}:${t.id}`;
  // 아직 아무것도 안 건드렸으면 지금 들어 있는 칸을 펼쳐 둔다. null 은 일부러 닫은 것이다.
  if (!openMain.has(key) && currentId) {
    openMain.set(key, D.categories.find((c) => c.id === currentId)?.parentId || null);
  }
  const open = openMain.get(key);
  const mark = (id) => (id === currentId ? ' on' : '');
  let h = '<div class="picks" style="margin-top:13px">';

  const hinted = hintedId && D.categories.find((c) => c.id === hintedId);
  if (hinted) {
    h += `<button type="button" class="pick" data-pick="${t.id}" data-cat="${hinted.id}"
      style="background:var(--blue);color:#fff;border-color:var(--blue);font-weight:600">
      ${esc(hinted.icon || '')} ${esc(hinted.name)}</button>`;
  }

  for (const m of mainCats()) {
    if (hinted && m.id === hinted.id) continue;
    const kids = subCats(m.id);
    h += `<button type="button" class="pick${mark(m.id)}"
      ${kids.length ? `data-main="${ns}:${t.id}:${m.id}" aria-expanded="${open === m.id}"`
                    : `data-pick="${t.id}" data-cat="${m.id}"`}>
      ${esc(m.icon || '')} ${esc(m.name)}</button>`;
  }
  h += '</div>';

  const kids = open ? subCats(open) : [];
  if (kids.length) {
    h += '<div class="subs">';
    for (const c of kids) {
      h += `<button type="button" class="pick${mark(c.id)}" data-pick="${t.id}" data-cat="${c.id}">
        ${esc(c.icon || '')} ${esc(c.name)}</button>`;
    }
    const parent = D.categories.find((x) => x.id === open);
    h += `<button type="button" class="pick" data-pick="${t.id}" data-cat="${open}">
      ${esc(parent?.name || '')} 전체</button>`;
    h += '</div>';
  }
  return h;
}

/**
 * 「지난 N건도」 의 N. 고른 범위에 따라 달라지므로 범위를 바꾸면 다시 센다.
 *
 * 규칙만 고치고 지난 기록을 놔두면, 잘못 분류된 달은 영영 잘못된 채로 남는다.
 */
function sweepCount(txn, scopeValue) {
  const { scope, keyword } = parseScope(scopeValue, txn.merchantRaw);
  const word = keyword || normalizeMerchant(txn.merchantRaw);
  if (!word) return 0;
  return D.txns.filter((t) => {
    if (t.id === txn.id || t.type !== 'expense' || !t.categoryId) return false;
    const other = normalizeMerchant(t.merchantRaw);
    if (!other) return false;
    return scope === 'contains' ? other.includes(word) : other === word;
  }).length;
}

function scopeOptions(merchantRaw, hint) {
  const normalized = normalizeMerchant(merchantRaw);
  const out = [];
  if (hint.scope === 'contains' && hint.keyword && hint.keyword !== normalized) {
    out.push(`모두: ${hint.keyword}`);
  }
  if (normalized) out.push(`이 가게만: ${normalized}`);
  out.push('이번만');
  return out;
}

function renderFixed() {
  const list = [...D.recurring].sort((a, b) => (a.dayOfMonth || 0) - (b.dayOfMonth || 0));
  const total = list.reduce((s, r) => s + Number(r.expectedAmount || 0), 0);

  let h = `<div class="card"><div class="lbl">매달 빠져나가는 돈</div>
    <div class="big num" style="font-size:34px;margin:9px 0 6px">₩${won(total)}</div>
    <div class="muted">1년이면 <b class="num" style="color:var(--spend)">₩${won(total * 12)}</b></div></div>`;

  h += '<div class="card">';
  if (!list.length) {
    h += `<div class="empty">넣어 둔 고정비가 없어요.<br>구독·통신비·보험료를 넣으면<br>빚 갚을 여력이 정확해져요.</div>`;
  } else {
    for (const r of list) {
      h += `<div class="item">
        <span class="muted num" style="width:34px">${r.dayOfMonth ? r.dayOfMonth + '일' : '—'}</span>
        <span class="grow" style="font-size:13.5px;font-weight:500">${esc(r.name)}</span>
        <span class="num" style="font-size:13.5px;font-weight:600">${won(r.expectedAmount)}</span>
        <span class="acts">
          <button type="button" class="act ghost small" data-edit="recurring:${r.id}">고치기</button>
          <button type="button" class="act danger" data-del="recurring:${r.id}">삭제</button></span></div>`;
    }
  }
  h += '</div>';

  h += `<form class="card" data-form="recurring">
    <div class="lbl" style="margin-bottom:12px">고정비 넣기</div>
    <input type="hidden" name="id">
    <div class="field"><label>이름</label><input name="name" placeholder="넷플릭스" required></div>
    <div class="fields">
      <div class="field"><label>금액</label><input name="expectedAmount" inputmode="numeric" placeholder="17,000" required></div>
      <div class="field"><label>결제일</label><input name="dayOfMonth" inputmode="numeric" placeholder="5"></div></div>
    <div class="field"><label>카테고리</label>
      <select name="categoryId">${catOptions()}</select></div>
    <button type="submit" class="act primary" style="width:100%">추가</button></form>`;

  $('fixed').innerHTML = h;
}

const ASSET_LABEL = { checking: '입출금', savings: '저축 · 투자', cash: '현금' };

function renderSetup() {
  const s = D.settings;
  const mine = D.merchants.filter((m) => m.defaultCategoryId && !m.isPassthrough && !m.alwaysAsk).length
             + D.rules.filter((r) => r.source === 'learned').length;

  const income = `<form data-form="settings">
    <div class="field"><label>매달 들어오는 돈</label>
      <input name="monthlyIncome" inputmode="numeric" value="${won(s.monthlyIncome)}"></div>
    <div class="field"><label>생활비 예산</label>
      <input name="variableBudget" inputmode="numeric" value="${won(s.variableBudget)}">
      <div class="muted" style="margin-top:6px">매달 나가는 고정비 말고, 그때그때 쓰는 돈이에요. 감으로 잡고 나중에 고쳐도 됩니다.</div></div>
    <div class="hr"></div>
    <div class="fields">
      <div class="field"><label>처음 빚 금액</label>
        <input name="debtStartAmount" inputmode="numeric" value="${won(s.debtStartAmount)}"></div>
      <div class="field"><label>다 갚을 날</label>
        <input name="debtTargetDate" type="date" value="${esc(s.debtTargetDate || '')}"></div></div>
    <div class="muted" style="margin:-4px 0 12px">얼마나 갚았는지를 이 금액에 견줘 보여줍니다. 비우면 지금 잔액이 기준이 돼요.</div>
    <div class="hr"></div>
    <div class="fields">
      <div class="field"><label>한 달을 언제부터 셀까</label>
        <select name="cycleStartDay">
          ${Array.from({ length: 28 }, (_, i) => i + 1).map((d) =>
            `<option value="${d}"${Number(s.cycleStartDay || 1) === d ? ' selected' : ''}>${d}일부터</option>`).join('')}
        </select></div>
      <div class="field"><label>쉬는 날이면</label>
        <select name="cycleMode">
          <option value="calendar"${s.cycleMode !== 'payday' ? ' selected' : ''}>그대로</option>
          <option value="payday"${s.cycleMode === 'payday' ? ' selected' : ''}>앞당김 (월급날)</option>
        </select></div></div>
    <div class="muted" style="margin:-4px 0 12px">
      <b>월급날</b>로 맞추면 "쓸 수 있는 돈"이 지갑 현실과 맞아요.
      월급날이 쉬는 날이면 돈은 앞당겨 들어오니 주기도 같이 당겨집니다.
      <b>1일</b>로 두면 달력 월이라 지난달과 견주기 좋고요.</div>
    <button type="submit" class="act primary" style="width:100%">저장</button></form>`;

  const line = (a, amount, note) => `<div class="item"><span class="grow">
      <span style="font-size:13.5px;font-weight:600">${esc(a.name)}</span><br>
      <span class="muted">${esc(note)}</span></span>
      <span class="num" style="font-size:14px;font-weight:600">${won(amount)}</span>
      <span class="acts">
        <button type="button" class="act ghost small" data-edit="accounts:${a.id}">고치기</button>
        <button type="button" class="act danger" data-del="accounts:${a.id}">삭제</button></span></div>`;

  const all = D.accounts.filter((a) => a.active !== false);
  const cashRows = all.filter((a) => ['checking', 'savings', 'cash'].includes(a.type));
  const debtRows = all.filter((a) => debtOf(a) > 0 || a.type === 'loan');
  const cardRows = all.filter((a) => a.type === 'card');

  const money = (cashRows.length
    ? cashRows.map((a) => line(a, cashOf(a),
        [TYPE_LABEL[a.type], Number(a.balance) < 0 ? '마이너스통장 — 빚으로 셉니다' : ''].filter(Boolean).join(' · ')))
        .join('')
    : '<div class="empty">아직 없어요.</div>')
    + `<div class="muted" style="margin-top:10px">통장 잔고는 입출금 문자가 올 때마다 알아서 맞춰져요. 적금·청약처럼 문자가 안 오는 건 직접 넣어 주세요.</div>`;

  const debts = debtRows.length
    ? debtRows.map((a) => line(a, debtOf(a),
        `${TYPE_LABEL[a.type]} · 연 ${Number(a.rate) || 0}%${a.billingDay ? ` · 매월 ${a.billingDay}일` : ''}`)).join('')
      + `<div class="muted" style="margin-top:10px">이자율을 넣으면 홈에서 비싼 빚부터 갚으라고 알려줘요.</div>`
    : '<div class="empty">없어요. 다행이네요.</div>';

  const cards = (cardRows.length
    ? cardRows.map((a) => line(a, 0,
        `${CARD_LABEL[a.cardType] || '신용'}${a.billingDay ? ` · 매월 ${a.billingDay}일 결제` : ''}${a.issuer ? ` · ${a.issuer}` : ''}`)
        .replace(/<span class="num"[^>]*>0<\/span>/, ''))
      .join('')
    : '<div class="empty">아직 없어요.</div>')
    + `<div class="muted" style="margin-top:10px">카드를 넣어 두면 다음 결제일에 얼마 나갈지 홈에서 알려줘요. 체크카드는 그 자리에서 빠지니 청구가 안 생깁니다.</div>`;

  const bankOptions = all.filter((a) => a.type === 'checking')
    .map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  const cardOptions = cardRows.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');

  const form = `<form data-form="accounts">
    <input type="hidden" name="id">
    <div class="field"><label>무엇인가요</label>
      <select name="type">
        <option value="checking">입출금 통장 (마이너스통장 포함)</option>
        <option value="savings">저축 · 투자</option>
        <option value="card">카드</option>
        <option value="loan">빚 — 리볼빙 · 대출</option>
        <option value="cash">현금</option></select></div>
    <div class="field"><label>이름</label>
      <input name="name" placeholder="우리은행 · 현대 이마트Plus · 리볼빙" required></div>

    <div class="fields" data-when="checking savings cash loan">
      <div class="field"><label>잔액</label>
        <input name="balance" inputmode="numeric" placeholder="500,000"></div>
      <div class="field" data-when="checking loan"><label>이자율 (연 %)</label>
        <input name="rate" inputmode="decimal" placeholder="19.9"></div></div>
    <label class="check" data-when="checking" style="margin:-2px 0 12px">
      <input type="checkbox" name="isMinus">
      <span>지금 마이너스예요 — 그만큼이 빚으로 잡힙니다 (마이너스통장)</span></label>

    <div class="fields" data-when="card">
      <div class="field"><label>카드 종류</label>
        <select name="cardType">
          <option value="credit">신용</option>
          <option value="debit">체크</option>
          <option value="hybrid">체크 + 신용</option></select></div>
      <div class="field"><label>결제일</label>
        <input name="billingDay" inputmode="numeric" placeholder="10"></div></div>
    <div class="field" data-when="card"><label>어느 통장에서 빠지나요</label>
      <select name="payFromId"><option value="">안 정함</option>${bankOptions}</select></div>
    <div class="field" data-when="loan"><label>어느 카드에서 넘어온 건가요</label>
      <select name="linkedAccountId"><option value="">카드와 상관없음</option>${cardOptions}</select>
      <div class="muted" style="margin-top:6px">리볼빙이면 그 카드를 골라 주세요. 다음 결제일 청구액에 함께 잡힙니다.</div></div>

    <button type="submit" class="act primary" style="width:100%">저장</button>
    <div class="muted" style="margin-top:10px">위 목록에서 <b>고치기</b> 를 누르면 여기로 불러와요.</div></form>`;

  const ingest = `<form data-form="ingestUrl">
    <div class="muted" style="margin-bottom:10px">이 화면 주소와 달라요. 아이폰 단축어가 문자를 보낼 곳입니다. 바뀌었을 때만 고치면 돼요.</div>
    <div class="field"><label>주소</label>
      <input name="url" inputmode="url" placeholder="https://ingest-xxxx-du.a.run.app"
        value="${esc(ingestUrl())}"></div>
    <div style="display:flex;gap:7px">
      <button type="submit" class="act ghost" style="flex:1">저장</button>
      <button type="button" class="act primary" id="pingIngest" style="flex:1">연결 확인</button>
    </div></form>
    <div class="hr"></div>
    <form data-form="token">
      <div class="muted" style="margin-bottom:12px">아이폰 단축어는 새벽에 주머니 속에서 혼자 돌아 로그인을 할 수 없어요. 그래서 미리 정해 둔 비밀번호로 들어옵니다. 이걸로는 <b>문자를 넣는 것만</b> 되고 가계부를 읽지는 못해요.</div>
      <div class="field"><label>연결 비밀번호</label>
        <input name="token" type="password" autocomplete="new-password" placeholder="8자 이상" required></div>
      <button type="submit" class="act primary" style="width:100%">비밀번호 저장</button>
      <div class="note warn" style="margin:12px 0 0">바꾸면 아이폰 <b>단축어의 token 칸도</b> 같이 고쳐야 문자가 계속 들어와요.</div></form>
    <div class="hr"></div>
    <form data-form="widgetToken">
      <div class="muted" style="margin-bottom:12px">잠금화면 위젯이 쓰는 비밀번호예요.
        문자 넣는 것과 <b>다른 비밀번호</b>를 쓰는 이유는, 넣는 쪽이 읽기까지 되면
        단축어 설정 하나가 새는 것과 가계부 전체가 새는 것이 같은 일이 되기 때문이에요.
        이걸로는 <b>합계 몇 개만</b> 읽히고 어디서 얼마 썼는지는 안 나갑니다.</div>
      <div class="field"><label>위젯 비밀번호</label>
        <input name="widgetToken" type="password" autocomplete="new-password" placeholder="8자 이상" required></div>
      <button type="submit" class="act primary" style="width:100%">위젯 비밀번호 저장</button>
      ${D.ingest?.widgetToken ? '<div class="note ok" style="margin:12px 0 0">정해져 있어요. Scriptable 위젯에 같은 값을 넣으세요.</div>' : ''}
    </form>`;

  const etc = `<div class="muted" style="margin-bottom:10px">내보내면 엑셀이나 다른 가계부에서 열 수 있어요.
      데이터가 이 앱 안에만 있으면 앱이 인질을 잡고 있는 거니까요.</div>
    <button type="button" class="act tint" style="width:100%;margin-bottom:9px" id="exportCsv">
      내역 내보내기 (CSV)</button>
    <div style="display:flex;gap:7px">
      <a class="act ghost" href="/data" style="flex:1;text-align:center;text-decoration:none;line-height:22px">원본 데이터</a>
      <button type="button" class="act ghost" id="signout" style="flex:1">로그아웃</button>
    </div>`;

  const cats = expenseCats();
  $('setup').innerHTML = [
    fold('goal', '목표',
      goalSummary(), goalForm()),
    fold('income', '수입과 예산',
      s.monthlyIncome ? `들어옴 ${won(s.monthlyIncome)} · 생활비 ${won(s.variableBudget)}` : '아직 안 넣음', income),
    fold('assets', '가진 돈',
      cashRows.length ? `${cashRows.length}개 · ${won(D.ledger.assets.total)}` : '없음', money),
    fold('debts', '빚',
      debtRows.length ? `${debtRows.length}개 · ${won(D.ledger.debt.total)}` : '없음', debts),
    fold('cards', '카드',
      cardRows.length ? `${cardRows.length}장` : '없음', cards),
    fold('add', '계좌 · 카드 · 빚 넣기', '한 군데서 다 넣어요', form),
    fold('shifts', '근무표',
      Object.keys(D.shifts).length ? `${Object.keys(D.shifts).length}일 넣음` : '안 넣음',
      renderShiftForm()),
    fold('catbudget', '갈래별 예산',
      D.ledger.byCategory.withLimit.length
        ? `${D.ledger.byCategory.withLimit.length}개 · ${won(D.ledger.byCategory.limitTotal)}`
        : '안 잡음', renderCategoryBudgets()),
    fold('cats', '카테고리',
      `큰 갈래 ${cats.filter((c) => !c.parentId).length} · 하위 ${cats.filter((c) => c.parentId).length}`,
      renderCategories()),
    fold('rules', '자동 분류 규칙',
      `내가 정한 것 ${mine}개`, renderRules()),
    fold('ingest', '문자 연결', '단축어가 문자를 보내는 곳', ingest),
    fold('etc', '그 밖에', '', etc),
  ].join('');
}

/**
 * 설정은 한 번 정해 놓고 잘 안 건드리는 것들이다. 다 펼쳐 두면 스크롤만 길어지고
 * 정작 찾는 게 어디 있는지 안 보인다. 접어 두되, 접힌 채로도 지금 값이 보이게 한다.
 */
// ───────────────────────────────────────────────── 직접 넣기

/**
 * 문자가 안 오는 돈은 여기로만 들어온다.
 *
 * 현금, 계좌이체, 지인에게 받은 용돈, 카드값 납부. 여태 "읽지 못한 문자"에
 * 걸려야만 손으로 넣을 수 있었는데, 애초에 문자가 없으면 걸릴 것도 없다.
 * 어느 화면에서든 누를 수 있어야 실제로 쓴다.
 */
const QUICK_LABEL = {
  expense: { what: '어디에 썼나요', from: '어디서 나갔나요', to: '' },
  income: { what: '무엇으로 받았나요', from: '', to: '어디로 들어왔나요' },
  transfer: { what: '무엇을 옮겼나요', from: '어디서 뺐나요', to: '어디로 옮겼나요' },
};

function quickKind() {
  return $('sheet')?.querySelector('[name="type"]')?.value || 'expense';
}

function openQuick(kind = 'expense') {
  const form = document.querySelector('[data-form="quick"]');
  form.reset();
  form.elements.type.value = kind;
  form.elements.date.value = new Date().toISOString().slice(0, 10);
  syncQuick();
  $('sheet').hidden = false;
  setTimeout(() => form.elements.amount.focus(), 60);
}

const closeQuick = () => { $('sheet').hidden = true; };

/** 종류마다 묻는 게 다르다. 수입에 "어디서 나갔나요"를 물으면 안 된다. */
function syncQuick() {
  const form = document.querySelector('[data-form="quick"]');
  if (!form) return;
  const kind = form.elements.type.value;

  for (const b of form.querySelectorAll('[data-kind]')) {
    if (b.dataset.kind === kind) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  for (const el of form.querySelectorAll('[data-qwhen]')) {
    el.hidden = !el.dataset.qwhen.split(' ').includes(kind);
  }

  $('quickWhatLabel').textContent = QUICK_LABEL[kind].what;
  if (QUICK_LABEL[kind].from) $('quickFromLabel').textContent = QUICK_LABEL[kind].from;
  if (QUICK_LABEL[kind].to) $('quickToLabel').textContent = QUICK_LABEL[kind].to;

  const cats = D.categories
    .filter((c) => !c.hidden && c.kind === (kind === 'income' ? 'income' : 'expense'))
    .sort(byOrder);
  form.elements.categoryId.innerHTML = kind === 'income'
    ? `<option value="">고르지 않음</option>`
      + cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')
    : catOptions();

  const live = D.accounts.filter((a) => a.active !== false);
  const opts = (list, none) => `<option value="">${none}</option>`
    + list.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  form.elements.accountId.innerHTML = opts(live, '안 정함');
  form.elements.toAccountId.innerHTML = opts(live, '안 정함');
}

/** 통장에 결제일이 있을 리 없고 카드에 이자율이 있을 리 없다. 쓰는 칸만 보인다. */
function syncAccountForm() {
  const form = document.querySelector('[data-form="accounts"]');
  const type = form?.elements?.type?.value;
  if (!type) return;
  for (const el of form.querySelectorAll('[data-when]')) {
    el.hidden = !el.dataset.when.split(' ').includes(type);
  }
}

const goalSummary = () => {
  const g = D.ledger.goal;
  if (g.kind === 'keep') return '아직 없음';
  return `${g.name} · ${g.pct}%`;
};

/**
 * 목표를 고른다.
 *
 * 빚 갚기로만 만들어 두면 다 갚은 다음 날 홈이 텅 빈다. 두 달 뒤가 목표인
 * 사람에게 두 달짜리 앱을 만들어 줄 수는 없다.
 */
function goalForm() {
  const g = D.settings.goal || {
    kind: D.ledger.debt.total ? 'payoff' : 'keep',
    name: '빚 정리',
    startAmount: D.settings.debtStartAmount || 0,
    targetAmount: 0,
    targetDate: D.settings.debtTargetDate || '',
  };
  const pick = (v, label, note) =>
    `<option value="${v}"${g.kind === v ? ' selected' : ''}>${label}${note ? ` — ${note}` : ''}</option>`;

  return `<form data-form="goal">
    <div class="field"><label>무엇을 할 건가요</label>
      <select name="kind">
        ${pick('payoff', '빚 갚기', '0 원까지')}
        ${pick('save', '모으기', '목표 금액까지')}
        ${pick('keep', '지켜보기', '목표 없이')}</select></div>
    <div class="field" data-goalwhen="payoff save"><label>이름</label>
      <input name="name" value="${esc(g.name || '')}" placeholder="리볼빙 정리 · 비상금 300만원"></div>
    <div class="fields" data-goalwhen="payoff save">
      <div class="field"><label data-goalstart>시작 금액</label>
        <input name="startAmount" inputmode="numeric" value="${won(g.startAmount)}"></div>
      <div class="field" data-goalwhen="save"><label>목표 금액</label>
        <input name="targetAmount" inputmode="numeric" value="${won(g.targetAmount)}"></div></div>
    <div class="field" data-goalwhen="payoff save"><label>언제까지</label>
      <input name="targetDate" type="date" value="${esc(g.targetDate || '')}"></div>
    <div class="muted" data-goalwhen="payoff save" style="margin:-4px 0 12px">
      진행률을 시작 금액에 견줘 보여줍니다. 날짜를 정하면 속도가 맞는지도 알려드려요.</div>

    <div class="hr"></div>
    <label class="check"><input type="checkbox" name="privacy" ${privacyOn() ? 'checked' : ''}>
      <span>금액 가리기 — 켜 두면 흐리게 보이고, 위쪽 눈 버튼으로 ${PEEK_SECONDS}초간 볼 수 있어요</span></label>
    <button type="submit" class="act primary" style="width:100%">저장</button></form>`;
}

/** 지켜보기를 고르면 금액 칸을 물을 이유가 없다. */
function syncGoalForm() {
  const form = document.querySelector('[data-form="goal"]');
  const kind = form?.elements?.kind?.value;
  if (!kind) return;
  for (const el of form.querySelectorAll('[data-goalwhen]')) {
    el.hidden = !el.dataset.goalwhen.split(' ').includes(kind);
  }
  const label = form.querySelector('[data-goalstart]');
  if (label) label.textContent = kind === 'payoff' ? '시작 금액 (처음 빚)' : '시작 금액 (지금까지 모은 돈)';
}

function fold(key, title, summary, body) {
  return `<details class="fold" data-fold="${key}" ${openFold.has(key) ? 'open' : ''}>
    <summary><span class="fold-t">${esc(title)}</span>
      <span class="fold-s">${esc(summary)}</span><span class="fold-x"></span></summary>
    <div class="fold-b">${body}</div></details>`;
}

const KIND_LABEL = { expense: '지출', income: '수입', transfer: '옮김' };

/**
 * 근무표 넣기.
 *
 * 31일을 하나씩 누르라고 하면 아무도 안 넣는다. 근무표는 어차피 한 달치가
 * 한 장으로 나오니, 글자로 죽 치는 게 제일 빠르다.
 */
function renderShiftForm() {
  const month = histMonth || D.ledger.month;
  const [y, m] = month.split('-');
  const now = shiftText(D.shifts, month);

  return `<form data-form="shifts">
    <input type="hidden" name="month" value="${month}">
    <div class="muted" style="margin-bottom:12px">
      <b>${Number(y)}년 ${Number(m)}월</b> 근무를 1일부터 차례로 적어 주세요.
      <b>D</b> 데이 · <b>E</b> 이브닝 · <b>N</b> 나이트 · <b>O</b> 오프.
      띄어 써도 되고 한글(데·이·나·오)로 적어도 돼요.
      <br>내역 화면에서 달을 옮기면 그 달 근무표를 넣을 수 있어요.</div>
    <div class="field"><label>근무</label>
      <input name="text" value="${esc(now.replace(/·/g, ''))}"
        placeholder="DDEENNOODDEENNOO…" autocapitalize="characters" autocomplete="off"
        style="font-family:ui-monospace,monospace;letter-spacing:2px"></div>
    <div class="muted" style="margin:-4px 0 12px">지금 넣은 것: <span
      style="font-family:ui-monospace,monospace;letter-spacing:1px">${esc(now)}</span></div>
    <button type="submit" class="act primary" style="width:100%">저장</button>
    <div class="note ok" style="margin:12px 0 0">새벽 8시 전에 쓴 돈은 <b>앞날 근무</b>로 셉니다.
      나이트 도중에 산 커피는 그 나이트에 쓴 돈이니까요.</div></form>`;
}

/**
 * 갈래별 예산.
 *
 * 생활비 총액 하나만 잡으면 "넘었다"는 알아도 어디서 넘었는지는 모른다.
 * 큰 갈래에만 잡는다 — 배달 · 외식 · 카페에 따로 잡으라고 하면 아무도 안 잡는다.
 */
function renderCategoryBudgets() {
  const limits = D.settings.categoryBudgets || {};
  const used = Object.fromEntries(D.ledger.byCategory.items.map((i) => [i.id, i.used]));
  const sum = mainCats().reduce((s, c) => s + Number(limits[c.id] || 0), 0);
  const total = Number(D.settings.variableBudget || 0);

  let h = `<div class="muted" style="margin-bottom:12px">잡은 갈래는 내역 화면에서 예산에 견줘 보여줘요.
    안 잡은 갈래는 그냥 쓴 금액만 나옵니다. 전부 잡을 필요 없어요 — 잘 새는 데만 잡으면 돼요.</div>
    <form data-form="catbudget">`;

  for (const c of mainCats()) {
    const now = Number(used[c.id] || 0);
    h += `<div class="item">
      <span class="grow"><span style="font-size:13.5px;font-weight:600">${esc(c.icon || '')} ${esc(c.name)}</span><br>
        <span class="muted">이 달에 <span class="num">${won(now)}</span> 씀</span></span>
      <span class="acts"><input name="${c.id}" inputmode="numeric" placeholder="안 잡음"
        value="${limits[c.id] ? won(limits[c.id]) : ''}"
        style="width:110px;min-height:38px;font-size:13px;text-align:right"></span></div>`;
  }

  h += `<div class="hr"></div>
    <div class="row" style="margin-bottom:12px">
      <span class="grow" style="font-size:13px;font-weight:600">잡은 예산 합</span>
      <span class="num" style="font-size:14px;font-weight:700;color:${
        total && sum > total ? 'var(--spend)' : 'var(--ink)'}">${won(sum)}</span></div>
    ${total ? `<div class="muted" style="margin:-6px 0 12px">생활비 예산은 <span class="num">${won(total)}</span>이에요${
      sum > total ? ' — 갈래별로 잡은 게 더 많아요.' : '.'}</div>` : ''}
    <button type="submit" class="act primary" style="width:100%">저장</button></form>`;
  return h;
}

/**
 * 카테고리를 직접 만들고 고치고 지운다.
 *
 * 내가 정해 준 열 갈래가 이 사람 삶과 딱 맞을 리가 없다. 안 쓰는 칸은 지우고
 * 필요한 칸은 만들 수 있어야 한다. 두 단계까지만 허용한다 — 세 단계가 되면
 * 고르는 데 드는 품이 분류해서 얻는 것보다 커진다.
 */
function renderCategories() {
  const all = [...D.categories].filter((c) => !c.hidden).sort(byOrder);
  const row = (c, depth) => {
    const used = D.txns.filter((t) => t.categoryId === c.id).length;
    return `<div class="item" style="padding-left:${depth * 20}px">
      <span class="grow"><span style="font-size:13.5px;font-weight:${depth ? 500 : 600}">
        ${esc(c.icon || '')} ${esc(c.name)}</span><br>
        <span class="muted">${used ? `${used}건` : '아직 안 쓰임'}${c.id === 'cat_unknown' ? ' · 갈 데 없는 결제가 여기로' : ''}</span></span>
      <span class="acts">
        <button type="button" class="act ghost small" data-editcat="${c.id}">고치기</button>
        ${c.id === 'cat_unknown' ? ''
          : `<button type="button" class="act danger" data-delcat="${c.id}">삭제</button>`}</span></div>`;
  };

  let h = `<div class="muted" style="margin-bottom:10px">안 쓰는 칸은 지우고, 필요한 칸은 만드세요.
    지워도 그 칸을 쓰던 결제는 사라지지 않고 위 갈래로 올라갑니다.</div>`;

  for (const kind of ['expense', 'income', 'transfer']) {
    const group = all.filter((c) => c.kind === kind);
    if (!group.length) continue;
    h += `<div class="lbl" style="margin:14px 0 0">${KIND_LABEL[kind]}</div>`;
    for (const c of group.filter((x) => !x.parentId)) {
      h += row(c, 0);
      for (const kid of group.filter((x) => x.parentId === c.id)) h += row(kid, 1);
    }
  }

  h += `<form data-form="categories" style="margin-top:16px">
    <div class="hr"></div>
    <div class="lbl" style="margin-bottom:10px">카테고리 넣기</div>
    <input type="hidden" name="id">
    <div class="fields">
      <div class="field" style="flex:3"><label>이름</label>
        <input name="name" placeholder="반려동물" required></div>
      <div class="field" style="flex:1"><label>아이콘</label>
        <input name="icon" placeholder="🐾" maxlength="4" style="text-align:center"></div></div>
    <div class="field"><label>어디에 들어갈까</label>
      <select name="parentId"><option value="">큰 갈래로 (맨 위에)</option>
        ${mainCats().map((c) => `<option value="${c.id}">${esc(c.name)} 아래로</option>`).join('')}
      </select></div>
    <div class="field"><label>무엇으로 세나</label>
      <select name="catKind">
        <option value="expense">지출</option>
        <option value="income">수입</option>
        <option value="transfer">옮김 (카드값·저축처럼 쓴 게 아닌 것)</option></select></div>
    <button type="submit" class="act primary" style="width:100%">저장</button></form>`;
  return h;
}

// ───────────────────────────────────────────────── 고치기

const formData = (form) => Object.fromEntries(
  [...form.elements].filter((f) => f.name)
    .map((f) => [f.name, f.type === 'checkbox' ? f.checked : f.value]));

async function pickCategory(txnId, categoryId, box) {
  const txn = D.txns.find((t) => t.id === txnId);
  if (!txn) return;

  // 인박스와 내역에 같은 거래가 동시에 떠 있을 수 있다. 누른 자리의 칸을 봐야 한다.
  const scopeValue = box?.querySelector('[data-scope]')?.value ?? '';
  const alsoPast = box?.querySelector('[data-alsopast]')?.checked === true;
  const { scope, keyword } = parseScope(scopeValue, txn.merchantRaw);

  const batch = writeBatch(db);
  batch.update(doc(col('txns'), txnId), { categoryId, status: 'confirmed' });

  const normalized = normalizeMerchant(txn.merchantRaw);
  let learned = '';

  if (scope === 'contains' && keyword.length >= 2) {
    // 같은 낱말로 다시 고르면 규칙이 쌓이지 않고 카테고리만 바뀐다
    const id = `rul_learned_${encodeURIComponent(keyword)}`;
    batch.set(doc(col('rules'), id), {
      id, priority: 10, matchType: 'contains', pattern: keyword,
      categoryId, source: 'learned', hitCount: 0,
    });
    learned = `앞으로 「${keyword}」는 자동`;
  } else if (scope === 'exact' && normalized) {
    const id = `mch_${encodeURIComponent(normalized)}`;
    batch.set(doc(col('merchants'), id), {
      id, normalizedName: normalized, displayName: txn.merchantRaw,
      defaultCategoryId: categoryId, isPassthrough: false, alwaysAsk: false,
    });
    learned = '앞으로 이 가게는 자동';
  }

  // 규칙을 만들면 밀려 있던 같은 가게 건들도 함께 정리한다.
  // 이미 분류한 건은 일부러 다르게 넣었을 수 있으므로, 시켰을 때만 건드린다.
  const sweepScope = scope === 'once' ? 'exact' : scope;
  const sweepWord = keyword || normalizeMerchant(txn.merchantRaw);
  let also = 0;
  let past = 0;

  if (sweepWord && (scope !== 'once' || alsoPast)) {
    for (const t of D.txns) {
      if (t.id === txnId || t.type !== 'expense' || t.categoryId === categoryId) continue;
      const waiting = t.status === 'pendingCategory' && !t.categoryId;
      if (!waiting && !alsoPast) continue;
      const other = normalizeMerchant(t.merchantRaw);
      if (!other) continue;
      const hit = sweepScope === 'contains' ? other.includes(sweepWord) : other === sweepWord;
      if (!hit) continue;
      batch.update(doc(col('txns'), t.id), { categoryId, status: 'confirmed' });
      if (waiting) also++; else past++;
    }
  }

  await batch.commit();
  await refresh();
  toast([`${catName(categoryId)}(으)로 저장`, learned,
         also ? `밀려 있던 ${also}건도 정리` : '',
         past ? `지난 ${past}건도 바꿈` : '']
    .filter(Boolean).join(' · '));
}

function parseScope(text, merchantRaw) {
  if (text.startsWith('모두:')) return { scope: 'contains', keyword: text.slice(3).trim() };
  if (text.startsWith('이 가게만')) return { scope: 'exact', keyword: normalizeMerchant(merchantRaw) };
  return { scope: 'once', keyword: '' };
}

/** 같은 갈래 안에서 맨 뒤 자리. 판올림이 쓰는 900번대는 건드리지 않는다. */
function nextOrder(parentId) {
  const kin = D.categories.filter((c) => (c.parentId || '') === parentId && !c.hidden);
  return Math.min(880, Math.max(0, ...kin.map((c) => Number(c.sortOrder) || 0)) + 1);
}

/** Firestore 배치는 한 번에 500개까지다. 넘으면 나눠 보낸다. */
async function commitAll(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(db);
    for (const op of ops.slice(i, i + 400)) op(batch);
    await batch.commit();
  }
}

/**
 * 카테고리를 지운다.
 *
 * 지운다고 그 칸을 쓰던 결제까지 사라지면 안 된다 — 지난달 쓴 돈이 통째로
 * 없어진다. 위 갈래로 올려 보내고, 올라갈 데가 없으면 미분류로 보낸다.
 */
async function deleteCategory(id) {
  const cat = D.categories.find((c) => c.id === id);
  if (!cat) return;
  if (id === 'cat_unknown') return toast('미분류는 못 지워요 — 갈 데 없는 결제가 여기로 와요');

  const kids = D.categories.filter((c) => c.parentId === id && !c.hidden);
  if (kids.length) return toast(`하위 ${kids.length}개를 먼저 옮기거나 지워 주세요`);

  const to = cat.parentId && D.categories.some((c) => c.id === cat.parentId)
    ? cat.parentId : 'cat_unknown';

  const txns = D.txns.filter((t) => t.categoryId === id);
  const rules = D.rules.filter((r) => r.categoryId === id);
  const shops = D.merchants.filter((m) => m.defaultCategoryId === id);
  const fixed = D.recurring.filter((r) => r.categoryId === id);
  const moves = [
    ...txns.map((t) => (b) => b.update(doc(col('txns'), t.id), { categoryId: to })),
    ...rules.map((r) => (b) => b.update(doc(col('rules'), r.id), { categoryId: to })),
    ...shops.map((m) => (b) => b.update(doc(col('merchants'), m.id), { defaultCategoryId: to })),
    ...fixed.map((r) => (b) => b.update(doc(col('recurring'), r.id), { categoryId: to })),
  ];

  // "16건" 은 무엇 16건인지 알 수 없다. 결제가 옮겨지는 것과 규칙이 옮겨지는 건
  // 무게가 다르므로 나눠서 말한다.
  const parts = [
    txns.length && `결제 ${txns.length}건`,
    rules.length && `자동 분류 규칙 ${rules.length}개`,
    shops.length && `가게 규칙 ${shops.length}개`,
    fixed.length && `고정비 ${fixed.length}개`,
  ].filter(Boolean);

  const msg = parts.length
    ? `「${cat.name}」 을(를) 쓰던 ${parts.join(', ')}가 「${catName(to)}」(으)로 옮겨집니다.\n\n지울까요?`
    : `「${cat.name}」 을(를) 지울까요?`;
  if (!confirm(msg)) return;

  await commitAll([
    ...moves,
    (b) => b.delete(doc(col('categories'), id)),
    // 판올림 때 되살아나지 않게 지웠다는 사실을 남긴다
    (b) => b.set(doc(db, 'users', uid, 'meta', 'settings'),
      { removedCategories: [...(D.settings.removedCategories || []), id] }, { merge: true }),
  ]);
  await refresh();
  toast(moves.length ? `지웠어요 — ${parts.join(', ')}는 ${catName(to)}(으)로` : '지웠어요');
}

async function saveDoc(kind, values) {
  const name = values.name?.trim();
  if (kind !== 'settings' && !name) return toast('이름을 적어 주세요');

  if (kind === 'settings') {
    await setDoc(doc(db, 'users', uid, 'meta', 'settings'), {
      monthlyIncome: parseAmount(values.monthlyIncome) || 0,
      variableBudget: parseAmount(values.variableBudget) || 0,
      debtStartAmount: parseAmount(values.debtStartAmount) || 0,
      debtTargetDate: values.debtTargetDate || '',
      cycleStartDay: Math.min(28, Math.max(1, Number(values.cycleStartDay) || 1)),
      cycleMode: values.cycleMode || 'calendar',
    });
  } else if (kind === 'accounts') {
    const type = values.type || 'checking';
    const existing = D.accounts.find((a) => a.id === values.id)
      || D.accounts.find((a) => a.name === name);
    const ref = existing ? doc(col('accounts'), existing.id) : doc(col('accounts'));
    const amount = parseAmount(values.balance) || 0;

    await setDoc(ref, {
      id: ref.id, name, type,
      // 카드는 잔액을 쓰지 않는다 — 얼마 나갈지는 거래에서 센다.
      // 빚은 갚아야 할 금액이라 늘 양수다. 마이너스통장만 음수를 그대로 둔다.
      // 아이폰 숫자 키패드에는 빼기 기호가 없다. 부호를 치게 하는 대신 물어본다.
      balance: type === 'card' ? 0
        : (type === 'loan' ? Math.abs(amount)
        : (type === 'checking' && values.isMinus === true ? -Math.abs(amount) : Math.abs(amount))),
      rate: Number(values.rate) || 0,
      cardType: type === 'card' ? (values.cardType || 'credit') : '',
      billingDay: Number(values.billingDay) || null,
      payFromId: type === 'card' ? (values.payFromId || '') : '',
      linkedAccountId: type === 'loan' ? (values.linkedAccountId || '') : '',
      balanceAt: new Date().toISOString(), active: true,
    }, { merge: true });

  } else if (kind === 'categories') {
    const parentId = values.parentId || '';
    const me = D.categories.find((c) => c.id === values.id);
    const parent = D.categories.find((c) => c.id === parentId);
    // 두 단계까지만. 세 단계가 되면 고르는 품이 분류해서 얻는 것보다 커진다.
    if (parent?.parentId) return toast('하위의 하위는 만들 수 없어요');
    if (me && parentId === me.id) return toast('자기 자신 아래로는 못 넣어요');
    if (me && parentId && D.categories.some((c) => c.parentId === me.id && !c.hidden)) {
      return toast('하위가 있는 갈래는 다른 갈래 밑으로 옮길 수 없어요');
    }
    const ref = me ? doc(col('categories'), me.id)
                   : doc(col('categories'), `cat_u_${Date.now().toString(36)}`);
    await setDoc(ref, {
      id: ref.id, name, parentId,
      kind: values.catKind || me?.kind || 'expense',
      icon: String(values.icon || '').trim().slice(0, 4),
      sortOrder: me?.sortOrder ?? nextOrder(parentId),
      hidden: false,
      userEdited: true,          // 다음 판올림 때 덮어쓰지 않는다
    }, { merge: true });

  } else if (kind === 'recurring') {
    const existing = D.recurring.find((r) => r.id === values.id);
    const ref = existing ? doc(col('recurring'), existing.id) : doc(col('recurring'));
    await setDoc(ref, {
      id: ref.id, name,
      expectedAmount: parseAmount(values.expectedAmount) || 0,
      dayOfMonth: Number(values.dayOfMonth) || null,
      categoryId: values.categoryId || null,
    });
  }

  await refresh();
  toast('저장했어요');
}

/**
 * 수집 창구를 실제로 두드려 본다.
 *
 * 토큰 없이 보내면 함수가 unauthorized 로 되받는데, 그 대답이 오는 것 자체가
 * 주소가 살아 있다는 뜻이다. 주소를 손으로 옮겨 적기 전에 확인하는 게 낫다.
 */
/** 내보내기. 파일로 떨어뜨려 놓으면 어디서든 연다. */
function exportCsv() {
  const csv = toCSV(D.txns, { categories: D.categories, accounts: D.accounts });
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `budget-${new Date().toISOString().slice(0, 10)}.csv`;
  // 문서에 안 붙인 링크는 브라우저가 파일 이름을 흘린다. 붙였다 떼는 게 확실하다.
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`${D.txns.length}건을 내보냈어요`);
}

async function pingIngest() {
  if (!ingestUrl()) return toast('주소를 먼저 저장해 주세요');
  toast('두드려 보는 중…');
  try {
    const res = await fetch(ingestUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: '__ping__', body: '' }),
    });
    const data = await res.json().catch(() => ({}));

    if (data.reason === 'unauthorized') return toast('✅ 주소가 살아 있어요');
    if (data.reason === 'no-token') return toast('주소는 살아 있어요 — 아래에서 토큰을 먼저 저장하세요');
    if (data.reason === 'not-set-up') return toast('주소는 살아 있는데 주인이 안 잡혔어요');
    if (res.status === 403) return toast('❌ 함수가 비공개예요 — 알려 주세요');
    if (res.status === 404) return toast('❌ 주소를 찾지 못했어요 — 함수가 배포됐는지 확인하세요');
    return toast(`응답: ${res.status} ${data.reason || ''}`);
  } catch (err) {
    toast(`❌ 닿지 않아요 — ${err.message}`);
  }
}

// ───────────────────────────────────────────────── 이벤트

/**
 * 저장이 실패해도 화면이 조용했다. 권한이 없어 못 고치는 건지, 눌리지 않은
 * 건지 알 길이 없으면 쓰는 사람이 자기 탓을 하게 된다. 실패는 말해 줘야 한다.
 */
function guard(handler) {
  return async (e) => {
    try {
      await handler(e);
    } catch (err) {
      const msg = String(err?.code || err?.message || err);
      if (msg.includes('permission-denied')) toast('권한이 없어요 — 보안 규칙을 확인해 주세요');
      else toast(`실패: ${msg}`);
      console.error(err);
    }
  };
}

document.addEventListener('click', guard(async (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    for (const id of ['home', 'history', 'inbox', 'fixed', 'setup'])
      $(id).hidden = id !== tab.dataset.tab;
    document.querySelectorAll('.tabs [data-tab]').forEach((b) => {
      if (b.dataset.tab === tab.dataset.tab) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    window.scrollTo(0, 0);
    return;
  }

  const month = e.target.closest('[data-month]');
  if (month) {
    histMonth = shiftMonth(histMonth || D.ledger.month, Number(month.dataset.month));
    histOpen = null;
    editTxn = null;
    renderHistory();
    window.scrollTo(0, 0);
    return;
  }

  const open = e.target.closest('[data-open]');
  if (open) {
    histOpen = histOpen === open.dataset.open ? null : open.dataset.open;
    renderHistory();
    return;
  }

  const tx = e.target.closest('[data-tx]');
  if (tx) {
    editTxn = editTxn === tx.dataset.tx ? null : tx.dataset.tx;
    renderHistory();
    return;
  }

  const main = e.target.closest('[data-main]');
  if (main) {
    const [ns, txnId, catId] = main.dataset.main.split(':');
    const key = `${ns}:${txnId}`;
    openMain.set(key, openMain.get(key) === catId ? null : catId);
    if (ns === 'hist') renderHistory(); else renderInbox();
    return;
  }

  const pick = e.target.closest('[data-pick]');
  if (pick) {
    const box = pick.closest('.edit') || pick.closest('.card');
    return pickCategory(pick.dataset.pick, pick.dataset.cat, box);
  }

  const ignore = e.target.closest('[data-ignore]');
  if (ignore) {
    await updateDoc(doc(col('raw'), ignore.dataset.ignore), { parsedOk: true, parseNote: '거래 아님' });
    await refresh();
    return toast('치웠어요');
  }

  const addFixed = e.target.closest('[data-addfixed]');
  if (addFixed) {
    const f = detectRecurring({ transactions: D.txns, recurring: D.recurring, settings: D.settings })
      .find((x) => x.key === addFixed.dataset.addfixed);
    if (!f) return;
    const ref = doc(col('recurring'));
    await setDoc(ref, {
      id: ref.id, name: f.name,
      expectedAmount: f.expectedAmount,
      dayOfMonth: f.dayOfMonth,
      categoryId: f.categoryId || null,
      varies: f.varies,
      source: 'detected',
    });
    await refresh();
    return toast(`${f.name} 을(를) 고정비로 넣었어요`);
  }

  const noFixed = e.target.closest('[data-nofixed]');
  if (noFixed) {
    await setDoc(doc(db, 'users', uid, 'meta', 'settings'), {
      ignoredRecurring: [...(D.settings.ignoredRecurring || []), noFixed.dataset.nofixed],
    }, { merge: true });
    await refresh();
    return toast('다시 안 물어볼게요');
  }

  const offset = e.target.closest('[data-offset]');
  if (offset) {
    const [cancelId, originalId] = offset.dataset.offset.split(':');
    const c = D.txns.find((t) => t.id === cancelId);
    const o = D.txns.find((t) => t.id === originalId);
    if (!c || !o) return;
    await commitAll([
      (b) => b.update(doc(col('txns'), o.id), voidPatch(c)),
      (b) => b.update(doc(col('txns'), c.id), settledPatch(o)),
    ]);
    await refresh();
    return toast(`${o.merchantRaw || '그 결제'} 를 없던 일로 했어요`);
  }

  const dropCancel = e.target.closest('[data-dropcancel]');
  if (dropCancel) {
    await updateDoc(doc(col('txns'), dropCancel.dataset.dropcancel),
      { status: 'settled', offsetsId: 'none' });
    await refresh();
    return toast('치웠어요 — 통계엔 안 들어갑니다');
  }

  const delcat = e.target.closest('[data-delcat]');
  if (delcat) return deleteCategory(delcat.dataset.delcat);

  const editcat = e.target.closest('[data-editcat]');
  if (editcat) {
    const c = D.categories.find((x) => x.id === editcat.dataset.editcat);
    const form = document.querySelector('[data-form="categories"]');
    if (!c || !form) return;
    form.elements.id.value = c.id;
    form.elements.name.value = c.name;
    form.elements.icon.value = c.icon || '';
    form.elements.parentId.value = c.parentId || '';
    form.elements.catKind.value = c.kind || 'expense';
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return toast(`${c.name} 을(를) 불러왔어요 — 고치고 저장하세요`);
  }

  const edit = e.target.closest('[data-edit]');
  if (edit) {
    const [kind, id] = edit.dataset.edit.split(':');
    const table = { accounts: D.accounts, recurring: D.recurring }[kind] || [];
    const row = table.find((x) => x.id === id);
    const form = document.querySelector(`[data-form="${kind}"]`);
    if (row && form) {
      for (const field of form.elements) {
        if (!field.name) continue;
        const v = row[field.name];
        field.value = (v === null || v === undefined) ? '' : String(v);
      }
      if (kind === 'accounts') {
        // 화면에는 늘 양수로 보여 주고, 마이너스인지는 체크로 말한다
        form.elements.balance.value = row.type === 'card' ? '' : won(Math.abs(row.balance || 0));
        form.elements.isMinus.checked = Number(row.balance || 0) < 0;
        syncAccountForm();
      }
      const box = form.closest('.fold');
      if (box && !box.open) box.open = true;
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast(`${row.name} 을(를) 불러왔어요 — 고치고 저장하세요`);
    }
    return;
  }

  const del = e.target.closest('[data-del]');
  if (del && confirm('지울까요?')) {
    const [name, id] = del.dataset.del.split(':');
    await deleteDoc(doc(col(name), id));
    if (name === 'txns') editTxn = null;
    await refresh();
    return toast('지웠어요');
  }

  if (e.target.id === 'pingIngest') return pingIngest();

  if (e.target.id === 'exportCsv') return exportCsv();
  if (e.target.id === 'peek') return peek();
  if (e.target.id === 'quickOpen') return openQuick();
  if (e.target.closest('[data-close]')) return closeQuick();

  const seg = e.target.closest('[data-kind]');
  if (seg) {
    document.querySelector('[data-form="quick"]').elements.type.value = seg.dataset.kind;
    return syncQuick();
  }

  if (e.target.id === 'refresh') { await refresh(); return toast('새로 불러왔어요'); }
  if (e.target.id === 'signout') return signOut(auth);
}));



document.addEventListener('toggle', (e) => {
  const key = e.target?.dataset?.fold;
  if (!key) return;
  if (e.target.open) openFold.add(key); else openFold.delete(key);
}, true);

document.addEventListener('change', guard(async (e) => {
  // 범위를 바꾸면 몇 건이 딸려 오는지도 달라진다. 다시 그리면 고른 값이 날아가므로 숫자만 고친다.
  const scopeSel = e.target.closest('[data-scope]');
  if (scopeSel) {
    const box = scopeSel.closest('.edit');
    const label = box?.querySelector('[data-also]');
    const txn = D.txns.find((t) => t.id === scopeSel.dataset.scope);
    if (!label || !txn) return;
    const n = sweepCount(txn, scopeSel.value);
    label.querySelector('[data-alsocount]').textContent = n;
    label.hidden = !n;
    if (!n) label.querySelector('[data-alsopast]').checked = false;
    return;
  }

  if (e.target.name === 'type' && e.target.closest('[data-form="accounts"]')) {
    return syncAccountForm();
  }
  if (e.target.name === 'kind' && e.target.closest('[data-form="goal"]')) {
    return syncGoalForm();
  }

  const sel = e.target.closest('[data-recat]');
  if (!sel) return;
  const [kind, id] = sel.dataset.recat.split(':');
  const field = kind === 'merchants' ? 'defaultCategoryId' : 'categoryId';
  await updateDoc(doc(col(kind), id), { [field]: sel.value || null });
  await refresh();
  toast('바꿨어요');
}));

/**
 * 규칙이 여든 개가 넘는다. 다시 그리면 글자를 치던 칸에서 손이 떨어지므로
 * 줄을 숨기기만 한다.
 */
document.addEventListener('input', (e) => {
  if (e.target.id === 'histSearch') {
    histQuery = e.target.value;
    editTxn = null;
    renderHistory();
    // 다시 그리면서 손이 칸에서 떨어진다. 치던 자리로 돌려놓는다.
    const box = $('histSearch');
    if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    return;
  }
  if (e.target.id !== 'ruleFilter') return;
  const q = e.target.value.trim();
  for (const el of document.querySelectorAll('[data-rulekey]')) {
    el.hidden = Boolean(q) && !el.dataset.rulekey.includes(q);
  }
});

document.addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const form = e.target;
  const values = formData(form);

  if (form.dataset.raw) {
    const amount = parseAmount(values.amount);
    if (!amount) return toast('금액을 넣어 주세요');
    const raw = D.raw.find((r) => r.id === form.dataset.raw);
    const ref = doc(col('txns'));
    const batch = writeBatch(db);
    batch.set(ref, {
      id: ref.id, type: 'expense', amount, currency: 'KRW',
      occurredAt: raw?.receivedAt || new Date().toISOString(),
      merchantRaw: values.merchant || '', categoryId: values.categoryId || null,
      status: values.categoryId ? 'confirmed' : 'pendingCategory',
      source: 'manual', rawMessageId: form.dataset.raw, excludeFromBudget: false,
    });
    batch.update(doc(col('raw'), form.dataset.raw),
      { txnId: ref.id, parsedOk: true, parseNote: '손으로 넣음' });
    await batch.commit();
    await refresh();
    return toast('넣었어요');
  }

  if (form.dataset.form === 'quick') {
    const amount = Math.abs(parseAmount(values.amount) || 0);
    if (!amount) return toast('금액을 넣어 주세요');

    const kind = values.type || 'expense';
    const when = values.date
      ? new Date(`${values.date}T${new Date().toTimeString().slice(0, 8)}`).toISOString()
      : new Date().toISOString();

    const ref = doc(col('txns'));
    await setDoc(ref, {
      id: ref.id, type: kind, amount, currency: 'KRW', occurredAt: when,
      merchantRaw: String(values.merchantRaw || '').trim(),
      categoryId: kind === 'transfer' ? 'cat_cardbill' : (values.categoryId || null),
      accountId: kind === 'income' ? '' : (values.accountId || ''),
      toAccountId: kind === 'expense' ? '' : (values.toAccountId || ''),
      // 옮긴 돈은 쓴 돈이 아니다 — 세면 카드값만큼 지출이 부풀어 오른다
      excludeFromBudget: kind === 'transfer' ? true : values.excludeFromBudget === true,
      status: (kind !== 'expense' || values.categoryId) ? 'confirmed' : 'pendingCategory',
      source: 'manual',
    });
    closeQuick();
    await refresh();
    return toast(`${{ expense: '쓴 돈', income: '받은 돈', transfer: '옮긴 돈' }[kind]} ${won(amount)} 넣었어요`);
  }

  if (form.dataset.txn) {
    const amount = parseAmount(values.amount);
    if (!amount) return toast('금액을 넣어 주세요');
    await updateDoc(doc(col('txns'), form.dataset.txn), {
      amount,
      merchantRaw: String(values.merchantRaw || '').trim(),
      tags: parseTags(values.tags),
      memo: String(values.memo || '').trim().slice(0, 60),
      excludeFromBudget: values.excludeFromBudget === true,
    });
    await refresh();
    return toast('고쳤어요');
  }

  if (form.dataset.form === 'shifts') {
    const month = values.month || D.ledger.month;
    const parsed = parseShiftText(values.text, month);
    // 이 달 것만 갈아 끼운다. 다른 달 근무표까지 날리면 안 된다.
    const kept = Object.fromEntries(
      Object.entries(D.shifts).filter(([k]) => !k.startsWith(month)));
    await setDoc(doc(db, 'users', uid, 'meta', 'shifts'),
      { days: { ...kept, ...parsed } });
    await refresh();
    return toast(Object.keys(parsed).length
      ? `${Number(month.split('-')[1])}월 ${Object.keys(parsed).length}일치를 넣었어요`
      : '비웠어요');
  }

  if (form.dataset.form === 'catbudget') {
    const limits = {};
    for (const [id, v] of Object.entries(values)) {
      const n = parseAmount(v) || 0;
      if (n > 0) limits[id] = n;
    }
    await setDoc(doc(db, 'users', uid, 'meta', 'settings'), { categoryBudgets: limits }, { merge: true });
    await refresh();
    return toast(Object.keys(limits).length ? `${Object.keys(limits).length}개 갈래에 예산을 잡았어요` : '예산을 다 지웠어요');
  }

  if (form.dataset.form === 'goal') {
    setPrivacy(values.privacy === true);
    const kind = values.kind || 'keep';
    await setDoc(doc(db, 'users', uid, 'meta', 'settings'), {
      goal: {
        kind,
        name: String(values.name || '').trim() || (kind === 'payoff' ? '빚 정리' : '모으기'),
        startAmount: parseAmount(values.startAmount) || 0,
        targetAmount: kind === 'save' ? (parseAmount(values.targetAmount) || 0) : 0,
        targetDate: values.targetDate || '',
      },
    }, { merge: true });
    await refresh();
    return toast('저장했어요');
  }

  if (form.dataset.form === 'ingestUrl') {
    const url = values.url.trim();
    if (url && !/^https:\/\//.test(url)) return toast('https:// 로 시작해야 해요');
    await setDoc(doc(db, 'config/ingest'), { url }, { merge: true });
    await refresh();
    return toast('저장했어요');
  }

  if (form.dataset.form === 'widgetToken') {
    const token = values.widgetToken.trim();
    if (token.length < 8) return toast('8자 이상으로 해 주세요');
    if (/[\s&?#%+/]/.test(token)) return toast('공백과 & ? # % + / 는 쓸 수 없어요');
    await setDoc(doc(db, 'config/ingest'), { widgetToken: token }, { merge: true });
    form.reset();
    await refresh();
    return toast('저장했어요 — 위젯 스크립트의 TOKEN 도 고쳐 주세요');
  }

  if (form.dataset.form === 'token') {
    const token = values.token.trim();
    if (token.length < 8) return toast('8자 이상으로 해 주세요');
    if (/[\s&?#%+/]/.test(token)) return toast('공백과 & ? # % + / 는 쓸 수 없어요');
    await setDoc(doc(db, 'config/ingest'), { token }, { merge: true });
    form.reset();
    return toast('저장했어요 — 단축어의 token 도 고쳐 주세요');
  }

  if (form.dataset.form) {
    await saveDoc(form.dataset.form, values);
    if (form.dataset.form !== 'settings') form.reset();
  }
}));

start();
