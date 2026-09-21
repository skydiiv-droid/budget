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
  getFirestore, initializeFirestore, persistentLocalCache, persistentSingleTabManager,
  collection, doc, getDoc, getDocs, setDoc, updateDoc,
  deleteDoc, writeBatch, query, orderBy, limit, where,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

import { ledger, monthSpending, breakdown, shiftMonth, monthKey, sameSpanLastMonth, pace,
         windowStart, hasOlderThan, paceShift } from './shared/ledger.js';
import { TYPE_LABEL, CARD_LABEL, debtOf, cashOf, matchCard } from './shared/accounts.js';
import { findOriginal, openCancels, voidPatch, settledPatch } from './shared/cancel.js';
import { trend, categoryBudgets, monthlyFixed } from './shared/ledger.js';
import { search, knownTags, parseTags } from './shared/search.js';
import { toCSV } from './shared/csv.js';
import { detectRecurring } from './shared/detect.js';
import { parseShiftText, shiftText, shiftStats, SHIFT_LABEL } from './shared/shifts.js';
import { findDuties, dutyPeople, dutiesOf, toShifts, dutyEndpoint, monthInUrl }
  from './shared/duty.js';
import { cardCheck, balanceCheck } from './shared/anchors.js';
// candidates 는 취소 상계에서 쓰는 지역 변수와 이름이 겹친다. 갈아 두면
// 한쪽을 고칠 때 다른 쪽이 조용히 가려지는 일이 없다.
import { fixedStatus, lateFixed, parseKeywords, candidates as fixedCandidates }
  from './shared/fixed.js';
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
let fixPick = null;      // '출금됐습니다' 를 누른 고정지출
let dutyFound = null;    // 근무표 앱에서 방금 읽어 온 것

/**
 * 거래를 어디까지 읽어 왔나.
 *
 * 처음엔 최근 500건만 읽었다. 몇 달 지나면 그 밖의 거래가 **아무 말 없이**
 * 화면에서 사라진다 — 검색해도 없다고 나오고 그래프의 옛 달이 0원이 된다.
 * 지워진 것과 안 읽어 온 것이 똑같아 보이는 게 제일 나쁘다.
 *
 * 이제 날짜로 끊고, 그보다 옛 것이 있으면 있다고 말한다. 다 필요한 일
 * (검색 · 내보내기 · 옛 달 보기)에서는 마저 읽는다.
 */
let wantAll = false;
let olderTxns = null;    // 창 밖의 거래. 한 번 읽어 두고 들고 간다.

/**
 * 창 밖 거래를 다시 읽게 한다.
 *
 * 안 그러면 전체를 한 번 읽은 뒤로 무엇을 누르든 매번 전부 다시 내려받는다.
 * 거래를 건드리는 곳은 이걸 불러야 한다 — 안 부르면 그 옛 줄만 옛 값으로
 * 남는다. `txnwrite.test.js` 가 빠뜨린 곳을 잡는다.
 */
const dropOlder = () => { olderTxns = null; };
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
    screen(`<h1>설정이 없습니다</h1>
      <p class="muted" style="margin-top:10px;line-height:1.7">
        Firebase 콘솔 → 프로젝트 설정 → <b>내 앱</b> 에서<br>
        웹 앱(&lt;/&gt;)을 추가하세요.
      </p>`);
    return;
  }

  projectId = config.projectId;
  const app = initializeApp(config);
  auth = getAuth(app);
  db = openDb(app);
  watchNetwork();

/**
 * 읽은 것을 기기에 남겨 둔다.
 *
 * 병원 지하와 지하철에서는 신호가 없다. 그때 흰 화면만 뜨면 쓸 수가 없다.
 * 남겨 두면 마지막으로 본 것이 그대로 뜨고, 그 사이에 적은 것은 신호가
 * 돌아올 때 알아서 올라간다.
 *
 * 창을 여러 개 띄우면 한쪽만 저장소를 쥔다. 아이폰에서 쓰는 앱이라 그래도 되고,
 * 저장소를 못 쓰는 환경(사파리 비공개 모드)이면 그냥 예전처럼 돈다.
 */
function openDb(app) {
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }),
    });
  } catch {
    return getFirestore(app);
  }
}

/** 끊겼는지 알려 준다. 안 알려 주면 "왜 안 바뀌지"가 된다. */
function watchNetwork() {
  const paint = () => {
    const off = navigator.onLine === false;
    document.body.classList.toggle('offline', off);
    let bar = $('offbar');
    if (!off) { bar?.remove(); return; }
    if (bar) return;
    bar = document.createElement('div');
    bar.id = 'offbar';
    bar.className = 'offbar';
    bar.textContent = '오프라인 — 마지막으로 불러온 내역입니다. 적은 것은 연결되면 올라갑니다.';
    document.body.appendChild(bar);
  };
  addEventListener('online', paint);
  addEventListener('offline', paint);
  paint();
}

  onAuthStateChanged(auth, async (user) => {
    if (!user) return showSignIn();
    uid = user.uid;
    try {
      await claimOwner(user);
      await seedIfEmpty();
      await syncCategories();
      await migrateDebts();
      await fixSeededAccounts();
      await migrateRevolving();
      await refresh();
    } catch (err) {
      if (navigator.onLine === false) {
        screen(`<h1>오프라인입니다</h1>
          <p class="muted" style="margin-top:10px">신호가 돌아오면 다시 열립니다.<br>
          한 번도 연 적이 없으면 저장해 둔 것도 없습니다.</p>
          <button class="act ghost" style="margin-top:16px" onclick="location.reload()">다시 시도</button>`);
        return;
      }
      screen(`<h1>열지 못했습니다</h1>
        <p class="muted" style="margin-top:10px;line-height:1.7">${esc(err.message)}</p>
        <button class="act ghost" style="margin-top:16px" onclick="location.reload()">다시 시도</button>`);
    }
  });
}

function showSignIn() {
  screen(`<h1>가계부</h1>
    <p class="muted" style="margin:10px 0 20px">구글 계정으로 로그인합니다</p>
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
/**
 * 리볼빙을 따로 빌린 돈으로 두던 걸 카드 속성으로 옮긴다.
 *
 * 리볼빙은 대출이 아니라 카드의 성질이다. 따로 두면 청구액을 셀 때 이월분을
 * 어디서 가져와야 할지가 매번 애매하고, 약정비율을 걸 데가 없다.
 */
async function migrateRevolving() {
  const all = await readAll('accounts');
  const cards = all.filter((c) => c.type === 'card' && c.active !== false);

  // 엮어 둔 카드가 있으면 그걸 쓰고, 없으면 이름으로 찾는다.
  // "현대카드 리볼빙" 은 발급사 이름을 품고 있다.
  const cardFor = (loan) => {
    const byLink = cards.find((c) => c.id === loan.linkedAccountId);
    if (byLink) return byLink;
    const name = String(loan.name || '');
    if (!/리볼빙/.test(name)) return null;
    return cards.find((c) => c.issuer && name.includes(c.issuer))
      || cards.find((c) => name.includes(String(c.name || '').split(/\s/)[0]))
      || null;
  };

  const pairs = all
    .filter((a) => a.type === 'loan')
    .map((loan) => [loan, cardFor(loan)])
    .filter(([, card]) => card);
  if (!pairs.length) return;

  const ops = [];
  for (const [loan, card] of pairs) {
    ops.push((b) => b.set(doc(col('accounts'), card.id), {
      revolving: true,
      revolvingBalance: Math.abs(Number(loan.balance) || 0),
      revolvingRate: Number(loan.rate) || 0,
      // 약정비율은 카드사 앱에서 정하는 값이라 모른다. 전액 결제로 두고
      // 사용자가 고치게 한다 — 모르는 값을 지어내면 청구액이 조용히 틀린다.
      // 약정비율은 카드사 앱에서 정하는 값이라 모른다. 이미 정해 둔 게 있으면
      // 그걸 두고, 없을 때만 전액 결제로 둔다 — 모르는 값을 지어내면 청구액이
      // 조용히 틀린다.
      revolvingRatio: Number(card.revolvingRatio) || 100,
    }, { merge: true }));
    ops.push((b) => b.delete(doc(col('accounts'), loan.id)));
  }
  await commitAll(ops);
}

/**
 * 문자로 들어온 거래를 카드에 붙인다.
 *
 * 문자에는 "현대 미래에셋 승인"으로 찍히는데 파서는 발급사를 떼고 "미래에셋"만
 * 남긴다. 등록한 이름과 글자가 달라 어느 카드인지 못 붙었고, 그래서 청구액에도
 * 누적 대조에도 그 거래가 안 잡혔다. 화면에서는 보이는데 합계에는 없으니
 * 숫자가 안 맞는 걸 눈으로 보고도 이유를 알 수 없었다.
 *
 * 이름으로 찾는 건 화면에서도 하지만, 붙여 두면 카드 이름을 바꿔도 안 끊긴다.
 */
async function bindCardTransactions() {
  const loose = D.txns.filter((t) => !t.accountId && t.cardName);
  if (!loose.length) return 0;

  const ops = [];
  for (const t of loose) {
    const card = matchCard(t.cardName, D.accounts);
    if (!card) continue;
    ops.push((b) => b.update(doc(col('txns'), t.id), { accountId: card.id }));
  }
  if (!ops.length) return 0;
  await commitAll(ops);
  dropOlder();
  return ops.length;
}

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

/**
 * 나머지 거래까지 마저 읽는다.
 *
 * 검색 · 내보내기 · 옛 달 보기는 다 있어야 맞는 답이 나온다. 한 번 읽으면
 * 이 세션 동안은 계속 다 들고 간다 — 다시 반쪽이 되면 또 조용히 틀린다.
 */
/**
 * 그 고정지출에 이어 붙여 둔 거래를 다 푼다.
 *
 * 거래를 전부 읽어 올 것 없이 붙은 것만 물어보면 된다. 창 밖의 옛 거래에
 * 붙어 있어도 이쪽으로는 잡힌다.
 */
async function unlinkAll(recurringId) {
  const hit = await getDocs(query(col('txns'), where('recurringId', '==', recurringId)))
    .catch(() => null);
  if (!hit || hit.empty) return 0;
  await commitAll(hit.docs.map((d) => (b) => b.update(doc(col('txns'), d.id), { recurringId: '' })));
  dropOlder();
  return hit.docs.length;
}

async function loadAll(why) {
  if (wantAll) return false;
  wantAll = true;
  olderTxns = null;
  toast(why ? `${why} — 지난 내역을 마저 불러옵니다…` : '지난 내역을 마저 불러옵니다…');
  await refresh();
  return true;
}

/** 안 읽어 온 옛 내역이 있다고 알리는 줄. */
function olderNote(where) {
  if (!D.hasOlder) return '';
  const [y, m] = String(D.from).split('-');
  const since = `${Number(y)}년 ${Number(m)}월`;
  return `<div class="note warn" style="margin:12px 0 0">
    <b>${since} 이전 내역은 아직 불러오지 않았습니다.</b><br>
    ${esc(where)}
    <button type="button" class="act ghost small" style="margin-top:9px"
      id="loadAll">전체 불러오기</button></div>`;
}

async function refresh() {
  // 기본 화면이 쓰는 만큼은 늘 새로 읽는다. 창 밖의 옛 것은 잘 안 바뀌므로
  // 한 번 읽어 두고 들고 간다 — 매번 다시 받으면 뭘 누르든 몇 초씩 걸린다.
  const from = windowStart(new Date());
  const txnQuery = query(col('txns'), orderBy('occurredAt', 'desc'),
    where('occurredAt', '>=', from));
  const olderQuery = query(col('txns'), orderBy('occurredAt', 'desc'),
    where('occurredAt', '<', from));

  const [categories, rules, merchants, accounts, recurring, settlements,
         recent, fetchedOlder, raw, settingsSnap, shiftSnap, anchors, oldest] =
    await Promise.all([
      readAll('categories'), readAll('rules'), readAll('merchants'), readAll('accounts'),
      readAll('recurring'), readAll('settlements'),
      getDocs(txnQuery).then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))),
      wantAll && !olderTxns
        ? getDocs(olderQuery).then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() })))
        : Promise.resolve(null),
      // 최근 100통만 보면, 읽어 들인 문자가 그 자리를 채우는 사이 못 읽은
      // 옛 문자가 조용히 화면에서 사라진다. 못 읽은 것만 콕 집어 찾는다.
      getDocs(query(col('raw'), where('parsedOk', '==', false), limit(300)))
        .then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() })))
        .then((list) => list.sort((a, b) =>
          String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')))),
      getDoc(doc(db, 'users', uid, 'meta', 'settings')),
      getDoc(doc(db, 'users', uid, 'meta', 'shifts')),
      getDocs(query(col('anchors'), orderBy('at', 'desc'), limit(120)))
        .then((x) => x.docs.map((d) => ({ id: d.id, ...d.data() })))
        .catch(() => []),
      // 제일 오래된 거래 한 건. 창 밖에 뭐가 남았는지 알려면 이것만 있으면 된다.
      getDocs(query(col('txns'), orderBy('occurredAt', 'asc'), limit(1)))
        .then((x) => x.docs[0]?.data()?.occurredAt || '')
        .catch(() => ''),
    ]);

  if (fetchedOlder) olderTxns = fetchedOlder;
  const txns = wantAll && olderTxns ? [...recent, ...olderTxns] : recent;

  const settings = settingsSnap.exists() ? settingsSnap.data() : { ...SETTINGS };
  const ingestSnap = await getDoc(doc(db, 'config/ingest')).catch(() => null);
  const ingest = ingestSnap?.exists() ? ingestSnap.data() : {};
  const shifts = shiftSnap.exists() ? (shiftSnap.data().days || {}) : {};
  D = { categories, rules, merchants, accounts, recurring, settlements,
        txns, raw, settings, ingest, shifts, anchors, from, oldest,
        // 다 읽어 왔으면 창 밖에 남은 것도 없다
        hasOlder: !wantAll && hasOlderThan(oldest, from) };
  D.ledger = ledger({ transactions: txns, recurring, settlements, accounts,
                      categories, raw, settings });

  $('boot').hidden = true;
  $('app').hidden = false;
  setPrivacy(privacyOn());
  render();

  // 확실한 취소는 묻지 않고 맞문다. 애매한 것만 정리 탭으로 간다.
  await autoOffset();

  // 카드에 안 붙은 문자 거래가 있으면 붙인다. 안 붙으면 청구액에서 빠진다.
  if (await bindCardTransactions()) await refresh();
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
    dropOlder();
    done++;
  }
  if (!done) return;
  await commitAll(ops);
  await refresh();
  toast(`취소 ${done}건을 원결제와 상계했습니다`);
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
  syncRecurringForm();
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
  let h = `<option value=""${selected ? '' : ' selected'}>지정 안 함</option>`;
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
  let h = renderGap() + renderLate();

  // ── 이번 달 ────────────────────────────────────────────
  h += `<div class="card">
    <div class="row"><span class="lbl grow">이번 달 지출</span>
      <span class="muted">${run.dayOf}/${run.days}일</span></div>
    <div class="big num" style="font-size:38px;margin:10px 0 ${budget.limit ? 12 : 8}px">₩${won(spentTotal)}</div>`;

  if (budget.limit) {
    h += `<div class="bar"><i style="width:${Math.min(100, budget.usedPct)}%;background:${
      budget.usedPct > 100 ? 'var(--warn-mark)' : 'var(--blue)'}"></i></div>
      <div class="row" style="margin-top:9px">
        <span class="grow" style="font-size:13px;color:var(--ink2)">오늘 사용 가능액</span>
        <span class="num" style="font-size:19px;font-weight:700;color:${
          budget.perDay > 0 ? 'var(--up)' : 'var(--warn-mark)'}">₩${won(budget.perDay)}</span></div>
      <div class="muted">예산 ₩<span class="num">${won(budget.limit)}</span> 중 ${budget.usedPct}% 사용 · ${budget.daysLeft}일 남음</div>`;
  }

  if (prev.total > 0) {
    const gap = spentTotal - prev.total;
    const pct = Math.round((gap / prev.total) * 100);
    h += `<div class="note ${gap > 0 ? 'warn' : 'ok'}" style="margin:12px 0 0">
      지난달 같은 기간보다
      <b class="num">₩${won(Math.abs(gap))}</b> ${gap > 0 ? '더' : '덜'} 지출 (${pct > 0 ? '+' : ''}${pct}%).<br>
      ${/* 달 초 며칠치로 한 달을 점치면 숫자가 요동친다. 그때는 말하지 않는다. */''}
      ${run.enough ? `현재 속도라면 이번 달 <b class="num">₩${won(run.projected)}</b> 예상${
        budget.limit ? ` — 예산 <b class="num">₩${won(Math.abs(run.projected - budget.limit))}</b> ${run.projected > budget.limit ? '초과' : '미만'}` : ''}.` : ''}</div>`;
  } else if (!budget.limit) {
    h += `<div class="muted" style="margin-top:4px">설정에서 생활비 예산을 등록하면
      <b>오늘 사용 가능액</b>이 표시됩니다.</div>`;
  }

  h += `<div class="hr"></div>
    <button type="button" class="act tint" style="width:100%" data-tab="history">
      카테고리별 지출 보기 →</button></div>`;

  // ── 다음 카드값 ─────────────────────────────────────────
  if (cards.total) h += renderBills(cards);

  // ── 목표 ───────────────────────────────────────────────
  h += renderGoal(goal, debt, planned);

  // ── 순자산 ─────────────────────────────────────────────
  if (assets.total || debt.total) {
    h += `<div class="card">
      <div class="row"><span class="lbl grow">순자산</span><span class="muted">자산 − 부채</span></div>
      <div class="big num" style="font-size:28px;margin:9px 0 12px;color:${assets.net >= 0 ? 'var(--ink)' : 'var(--down)'}">
        ${assets.net < 0 ? '−₩' + won(-assets.net) : '₩' + won(assets.net)}</div>`;
    assets.items.filter((a) => a.balance).forEach((a) => {
      h += `<div class="row" style="padding:5px 0">
        <span class="grow" style="font-size:13px;color:var(--ink2)">${esc(a.name)}</span>
        <span class="num" style="font-size:13.5px;font-weight:600;color:var(--up)">${won(a.balance)}</span></div>`;
    });
    if (debt.total) {
      h += `<div class="row" style="padding:5px 0">
        <span class="grow" style="font-size:13px;color:var(--ink2)">부채</span>
        <span class="num" style="font-size:13.5px;font-weight:600;color:var(--down)">− ${won(debt.total)}</span></div>`;
    }
    h += '</div>';
  }

  // ── 이번 달 계산 ────────────────────────────────────────
  h += `<div class="card"><div class="lbl" style="margin-bottom:11px">이번 달 수지</div>
    ${flowRow('수입', planned.income, 'var(--up)', '+')}
    ${flowRow('고정지출', planned.fixed, 'var(--down)', '−')}
    ${flowRow('생활비 예산', planned.variableBudget, 'var(--down)', '−')}
    <div class="hr"></div>
    <div class="row"><span class="grow" style="font-size:14px;font-weight:600">잔여</span>
      <span class="big num" style="font-size:22px;color:${planned.available >= 0 ? 'var(--up)' : 'var(--down)'}">${won(planned.available)}</span>
    </div></div>`;

  const waiting = inbox.pending + inbox.unparsed + openCancels(D.txns).length;
  if (waiting) {
    h += `<button type="button" class="note warn" data-tab="inbox">
      확인할 내역 <b>${waiting}건</b> — 미분류 결제 ${inbox.pending}건, 인식 실패 문자 ${inbox.unparsed}건<br>
      <span style="text-decoration:underline">확인하기</span></button>`;
  }

  $('home').innerHTML = h;
}

/**
 * 맞지 않는 게 있으면 맨 위에 띄운다.
 *
 * 한두 번은 별것 아니지만 쌓이면 합계가 통째로 틀어진다. 정리 탭에 두면
 * 거기까지 가야 알게 되는데, 그때는 이미 몇 주가 지나 있다.
 */
function renderGap() {
  const cards = cardCheck({ anchors: D.anchors, transactions: D.txns, accounts: D.accounts })
    .filter((c) => !c.ok);
  const banks = balanceCheck({ anchors: D.anchors, accounts: D.accounts })
    .filter((b) => b.stale && !b.ok);
  if (!cards.length && !banks.length) return '';

  const total = cards.reduce((s, c) => s + Math.abs(c.gap), 0);
  const what = [
    cards.length ? `카드 ${cards.length}건` : '',
    banks.length ? `통장 ${banks.length}건` : '',
  ].filter(Boolean).join(' · ');

  return `<button type="button" class="note warn" style="margin-bottom:12px" data-tab="inbox">
    <b>카드사 · 은행 기록과 금액이 다릅니다</b> — ${what}${
      total ? `, 카드 <b class="num">${won(total)}</b> 차이` : ''}<br>
    누적되면 합계 전체가 어긋납니다.
    <span style="text-decoration:underline">확인하기</span></button>`;
}

/**
 * 빠져나갔어야 할 고정지출이 안 들어왔을 때.
 *
 * 자동이체는 문자가 오기는 오는데, 그 문자를 놓치면 합계만 조용히 비어 있다.
 * 예정일 다음 날까지(쉬는 날이면 다음 영업일의 다음 날까지) 안 들어오면
 * 여기서 말한다. 카드 대조와 달리 이건 건별이라 무엇이 빠졌는지가 바로 나온다.
 */
function renderLate() {
  const rows = lateFixed(fixedState());
  if (!rows.length) return '';

  const sum = rows.reduce((s, r) => s + (r.varies ? 0 : r.expected), 0);
  const names = rows.slice(0, 3).map((r) => r.name).join(' · ');

  return `<button type="button" class="note warn" style="margin-bottom:12px" data-tab="fixed">
    <b>고정지출 ${rows.length}건이 확인되지 않았습니다</b>${
      sum ? ` — 합계 <b class="num">${won(sum)}</b>` : ''}<br>
    ${esc(names)}${rows.length > 3 ? ` 외 ${rows.length - 3}건` : ''} · 출금 예정일이 지났습니다.
    <span style="text-decoration:underline">확인하기</span></button>`;
}

/**
 * 다음 결제일에 얼마 나가나.
 *
 * 리볼빙이 걸려 있으면 "얼마 내나"만으로는 반쪽이다. 적게 내는 만큼 다음 달로
 * 넘어가고 거기에 이자가 붙는데, 그게 안 보이면 리볼빙이 싸 보인다.
 * 청구 대상 → 이번에 낼 돈 → 넘어갈 돈을 다 펴서 보여 준다.
 */
function renderBills(cards) {
  const lead = cards.items[0];
  let h = `<div class="card">
    <div class="row"><span class="lbl grow">다음 카드 결제</span>
      <span class="muted">${lead.daysLeft}일 후</span></div>
    <div class="big num" style="font-size:30px;color:var(--down);margin:10px 0 4px">₩${won(cards.total)}</div>
    <div class="muted" style="margin-bottom:12px">${esc(dateLabel(lead.payAt))} 출금${
      lead.shifted ? ' — 결제일이 휴일이라 이월' : ''}</div>`;

  for (const b of cards.items) {
    h += `<div class="hr"></div>
      <div class="row" style="padding:2px 0 8px">
        <span class="grow" style="font-size:13px;font-weight:600">${esc(b.name)}</span>
        <span class="muted">${Number(b.month.split('-')[1])}월치</span></div>`;

    const line = (label, value, strong) => `<div class="row" style="padding:4px 0">
      <span class="grow" style="font-size:12.5px;color:var(--ink2)${strong ? ';font-weight:700' : ''}">${label}</span>
      <span class="num" style="font-size:13px;font-weight:${strong ? 700 : 600}">${won(value)}</span></div>`;

    if (!b.revolving) {
      h += line(b.open ? '이번 달 사용액' : '해당 월 사용액', b.usage, true);
      continue;
    }
    h += line(b.open ? '이번 달 사용액' : '해당 월 사용액', b.usage);
    if (b.carried) h += line('전월 이월잔액', b.carried);
    h += line('청구 대상', b.billed);
    // "(70%)" 만 적으면 왜 다 안 내는지 알 수가 없다. 리볼빙 때문이라고 말한다.
    h += line(`이번에 낼 돈 — 리볼빙 ${b.ratio}%`, b.total, true);
    h += `<div class="note warn" style="margin:10px 0 2px">
      잔액 <b class="num">${won(b.carryOut)}</b>은 다음 달로 이월됩니다${
        b.interest ? ` — 이자 <b class="num">${won(b.interest)}</b> 가산` : ''}.</div>`;
  }

  h += `<div class="muted" style="margin-top:10px">청구 대상은 <b>해당 월 1일부터 말일까지</b>의 사용액입니다.${
      lead.open ? ' 이번 달은 진행 중이라 계속 증가합니다.' : ''}</div></div>`;
  return h;
}

const GOAL_WORD = {
  payoff: { verb: '상환', left: '남은 부채', none: '상환할 부채가 없습니다' },
  save: { verb: '적립', left: '남은 목표액', none: '목표를 달성했습니다' },
};

/**
 * 갚는 것도 모으는 것도 "지금 얼마이고 어디까지 가야 하는가"라는 같은 모양이다.
 * 빚을 다 갚으면 다음 목표로 넘어갈 수 있어야 홈이 안 빈다.
 */
function renderGoal(goal, debt, planned) {
  if (goal.kind === 'keep') {
    return `<div class="card"><div class="empty">설정된 목표가 없습니다.<br>
      설정에서 <b>부채 상환</b> 또는 <b>저축</b>을 등록하면<br>진행률과 예상 완료 시점이 표시됩니다.</div></div>`;
  }
  const w = GOAL_WORD[goal.kind];
  let h = `<div class="card">
    <div class="row"><span class="lbl grow">${esc(goal.name)}</span>
      ${goal.daysToTarget !== null ? `<span class="muted">목표까지 D-${Math.max(0, goal.daysToTarget)}</span>` : ''}</div>`;

  if (goal.done) {
    h += `<div class="big" style="font-size:24px;margin:12px 0 8px;color:var(--blue)">${w.none} 🎉</div>
      <div class="muted">설정에서 다음 목표를 등록하세요.</div></div>`;
    return h;
  }

  h += `<div class="row" style="margin:10px 0 12px">
      <span class="grow" style="font-size:12.5px;color:var(--ink2)">${w.left}</span>
      <span class="big num" style="font-size:30px;color:${goal.kind === 'payoff' ? 'var(--down)' : 'var(--up)'}">₩${won(goal.remaining)}</span></div>
    <div class="bar"><i style="width:${Math.min(100, Math.max(2, goal.pct))}%;background:var(--blue)"></i></div>
    <div class="muted" style="margin-top:7px">
      <b style="color:var(--blue)">${goal.pct}% ${w.verb}</b> · 시작 ₩<span class="num">${won(goal.start)}</span>${
        goal.kind === 'save' ? ` · 목표 ₩<span class="num">${won(goal.target)}</span>` : ''}</div>`;

  if (goal.kind === 'payoff' && debt.items.length) {
    h += '<div class="hr"></div>';
    debt.items.forEach((d, i) => {
      h += `<div class="row" style="padding:7px 0">
        <span style="width:3px;height:26px;border-radius:2px;background:${i === 0 ? 'var(--down)' : '#CBD5E1'}"></span>
        <span class="grow"><span style="font-size:13.5px;font-weight:600">${esc(d.name)}</span><br>
          <span class="muted">연 ${Number(d.rate) || 0}%${i === 0 && debt.items.length > 1 ? ' · 우선 상환' : ''}</span></span>
        <span class="num" style="font-size:15px;font-weight:600">${won(d.amount)}</span></div>`;
    });
  }
  h += '</div>';

  if (!planned.income) {
    h += `<div class="note warn">월 수입이 등록되지 않았습니다.<br>등록하면 예상 완료 시점이 표시됩니다.</div>`;
  } else if (goal.paceMonths === null) {
    h += `<div class="note warn"><b>현재 상환 여력이 없습니다.</b><br>
      고정지출이나 생활비 예산을 줄여야 합니다.</div>`;
  } else if (goal.needPerMonth === null) {
    h += `<div class="note ok">현재 속도로 <b>${goal.paceMonths}개월</b> 소요됩니다.
      설정에서 목표 날짜를 등록하면 달성 가능 여부를 안내합니다.</div>`;
  } else if (goal.onTrack) {
    h += `<div class="note ok"><b>현재 속도로 ${goal.paceMonths}개월 — 목표 내 달성 가능.</b><br>
      월 ₩<span class="num">${won(goal.needPerMonth)}</span> 필요, 여력 ₩<span class="num">${won(planned.available)}</span>.</div>`;
  } else {
    h += `<div class="note warn"><b>현재 속도로 ${goal.paceMonths}개월 — 목표 대비 지연.</b><br>
      목표 내 달성하려면 월 <b class="num">₩${won(goal.needPerMonth)}</b>이 필요합니다.
      현재 여력 <b class="num">₩${won(planned.available)}</b>, <b class="num">₩${won(goal.shortfall)}</b> 부족합니다.</div>`;
  }
  return h + renderShift(goal, planned);
}

/**
 * 이번 달 아낀 것이 목표를 며칠 당기는가.
 *
 * 다른 줄은 다 "얼마 썼다"를 말한다. 그건 이 가계부를 쓰는 이유가 아니다.
 * 오늘 덜 쓴 것과 목표 사이를 이어 주는 줄은 여기 하나뿐이다.
 */
function renderShift(goal, planned) {
  const b = D.ledger.budget;
  if (!b.limit || !planned.income) return '';

  // 예산은 생활비에만 걸린 것이므로 견줄 것도 생활비 쪽 속도여야 한다.
  const run = pace(b.spent, D.ledger.month, D.settings.cycleStartDay);
  // 이틀치로 "16일 당겨집니다"라고 말하면 안 된다. 달의 3분의 1은 지나야 한다.
  if (!run.enough) return '';
  const saved = b.limit - run.projected;
  const s = paceShift(goal.remaining, planned.available, saved);
  if (!s) return '';

  const money = `<b class="num">₩${won(Math.abs(Math.round(saved)))}</b>`;
  if (s.unlocks) {
    return `<div class="note ok">이 속도로 아끼면 이번 달 ${money}이 남아
      <b>갚을 여력이 생깁니다.</b> 지금은 여력이 없습니다.</div>`;
  }
  if (s.stalls) {
    return `<div class="note warn">이 속도로 쓰면 이번 달 ${money}이 모자라
      <b>갚을 여력이 사라집니다.</b></div>`;
  }
  const days = Math.abs(s.days);
  const when = days >= 30 ? `${Math.round(days / 30.44 * 10) / 10}개월` : `${days}일`;
  return s.days > 0
    ? `<div class="note ok">이 속도로 아끼면 이번 달 ${money}이 남아
       <b>${esc(goal.name)}가 ${when} 당겨집니다.</b></div>`
    : `<div class="note warn">이 속도로 쓰면 예산보다 ${money} 더 써서
       <b>${esc(goal.name)}가 ${when} 밀립니다.</b></div>`;
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
    <div class="row"><span class="lbl grow">월별 지출</span>
      <span class="muted">단위: 천 원</span></div>
    <div class="trend" style="--h:${H}px">
      ${limit ? `<div class="tb-limit" style="bottom:${y(limit) + 17}px">
        <span>예산 <b class="num">${won(Math.round(limit / 1000))}</b></span></div>` : ''}
      ${bars}
    </div>
    ${months.at(-1).current ? `<div class="muted" style="margin-top:12px">
      연한 막대는 <b>현재 속도 기준</b> 이번 달 예상액입니다. 진행 중인 달이라 그대로 비교하면 낮게 보입니다.</div>` : ''}
  </div>`;
}

/**
 * 검색칸은 한 번만 그리고 그 아래만 갈아 끼운다.
 *
 * 글자를 칠 때마다 내역 화면을 통째로 다시 그리면 치고 있던 입력칸 자체가
 * 새것으로 바뀐다. 한글은 자모를 모아 한 글자를 만드는 중인데 그 칸이
 * 사라지므로 조합이 끊기고 글자가 깨진다.
 */
function histShell() {
  if ($('histSearch')) return $('histBody');
  $('history').innerHTML = `<div class="card" style="padding:12px 14px">
    <input id="histSearch" type="search" autocomplete="off" enterkeyhint="search"
      placeholder="가맹점 · 카테고리 · 금액 · 태그 검색"
      value="${esc(histQuery)}" style="min-height:42px"></div>
    <div id="histBody"></div>`;
  return $('histBody');
}

function renderHistory() {
  const body = histShell();

  // 찾는 중에는 달을 넘나들지 않는다. "그때 그 병원"이 몇 월인지 알면 안 찾는다.
  if (histQuery.trim()) {
    const hits = search(histQuery, { transactions: D.txns, categories: D.categories });
    const total = hits.reduce((sum, t) => sum + (t.type === 'expense' ? Number(t.amount || 0) : 0), 0);
    let f = '';
    if (!hits.length) {
      f += `<div class="card"><div class="empty">「${esc(histQuery)}」 검색 결과가 없습니다.<br>
        이름 일부만 입력해도 됩니다.</div>${
        olderNote('찾는 내역이 그 안에 있을 수 있습니다.')}</div>`;
    } else {
      f += `<div class="card">
        <div class="row"><span class="lbl grow">검색 결과 ${hits.length}건</span>
          <span class="num" style="font-size:15px;font-weight:700">${won(total)}</span></div></div>
        <div class="card" style="padding:4px 16px">${hits.slice(0, 80).map(txRow).join('')}</div>`;
      if (hits.length > 80) f += `<div class="muted" style="text-align:center;margin-top:8px">최근 80건만 표시합니다</div>`;
      f += olderNote('검색은 불러온 내역에서만 찾습니다.');
    }
    body.innerHTML = f;
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
    diff = ` · ${span}(₩<span class="num">${won(prev.total)}</span>)보다 <b class="num" style="color:${pct > 0 ? 'var(--warn-mark)' : 'var(--ink3)'}">`
         + `${pct > 0 ? '+' : pct < 0 ? '−' : '±'}${Math.abs(pct)}%</b>`;
  }

  let h = `<div class="card">
    <div class="row">
      <button type="button" class="act ghost small" data-month="-1" aria-label="지난달">←</button>
      <div class="grow" style="text-align:center">
        <div style="font-size:15px;font-weight:600">${Number(y)}년 ${Number(m)}월</div>
        <div class="muted">${D.settings.cycleStartDay || 1}일 시작 기준</div></div>
      <button type="button" class="act ghost small" data-month="1" aria-label="다음 달"
        ${atNow ? 'disabled style="opacity:.32"' : ''}>→</button>
    </div>
    <div class="hr"></div>
    <div class="lbl">이번 달 지출</div>
    <div class="big num" style="font-size:40px;margin:10px 0 7px">₩${won(total)}</div>
    <div class="muted">${rows.length}건${diff}</div>
  </div>`;

  if (!rows.length) {
    h += `<div class="card"><div class="empty">이번 달 지출 내역이 없습니다.<br>
      카드 문자가 수신되면 자동으로 등록됩니다.</div></div>`;
    body.innerHTML = h;
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
    <div class="lbl">카테고리별 지출</div>
    <div class="muted" style="margin:4px 0 6px">상위 카테고리를 누르면 하위가 열립니다.${
      limits.withLimit.length ? ' 예산을 설정한 카테고리는 예산 대비로 표시됩니다.' : ''}</div>`;
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
          cap?.over ? 'var(--warn-mark)' : 'var(--blue)'}"></i></span>
      </span>
      <span class="brk-amt num">${won(it.amount)}<br><span class="muted"${
        cap?.over ? ' style="color:var(--warn-mark);font-weight:700"' : ''}>${
        /* 한 칸에 두 뜻을 섞으면 안 된다 — 43% 가 예산의 43% 인지 전체의 43% 인지
           알 길이 없다. 막대가 무엇에 견준 것인지 글자로 말해 준다. */''}${
        cap?.limit ? `${cap.over ? '예산 초과' : `예산 ${cap.pct}%`}` : `비중 ${it.pct}%`}</span></span>
    </button>`;
    if (!open) continue;
    for (const sub of it.subs) {
      h += `<div class="brk-sub"><span class="grow">${esc(catIcon(sub.id))} ${esc(catName(sub.id))}
        <span class="muted">${sub.count}건</span></span>
        <span class="num" style="font-weight:600">${won(sub.amount)}</span></div>`;
    }
    if (!it.subs.length) {
      h += `<div class="brk-sub"><span class="muted">하위 카테고리 없음</span></div>`;
    }
  }
  h += '</div>';

  const days = new Map();
  for (const r of rows) {
    const key = String(r.occurredAt).slice(0, 10);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(r);
  }

  h += olderNote('월별 지출 그래프와 지난달 대비도 불러온 만큼만 셉니다.');
  h += `<div class="lbl" style="margin:20px 2px 0">지출 내역 · 누르면 수정</div>`;
  for (const [key, list] of days) {
    const d = new Date(`${key}T00:00:00`);
    h += `<div class="day">
      <span class="day-date">${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAY[d.getDay()]})</span>
      <span class="day-sum">${won(sumCounted(list))}</span></div>
      <div class="card" style="padding:4px 16px">${list.map(txRow).join('')}</div>`;
  }

  body.innerHTML = h;
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
      data-tab="setup">근무표를 등록하면 <b>근무 유형별 지출</b>을 볼 수 있습니다. 설정 → 근무표.</button>`;
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
    <span class="brk-amt num">${won(i.perDay)}<br><span class="muted">일 평균</span></span></div>`;

  return `<div class="card">
    <div class="row"><span class="lbl grow">근무 유형별 일 평균 지출</span>
      <span class="muted">${s.days}일 기준</span></div>
    <div class="muted" style="margin:4px 0 4px">총액이 아닌 일 평균입니다.</div>
    ${s.items.map((i) => line(i)).join('')}
    ${s.afterNight ? line(s.afterNight, true) : ''}
    ${s.gap > 5000 ? `<div class="note ok" style="margin:12px 0 0">
      <b>${esc(s.items[0].label)}</b>는 <b>${esc(s.items.at(-1).label)}</b>보다
      하루 <b class="num">${won(s.gap)}</b> 더 지출합니다.
      이번 달 ${esc(s.items[0].label)}가 ${s.items[0].days}일이므로
      <b class="num">${won(s.gap * s.items[0].days)}</b> 차이입니다.</div>` : ''}
  </div>`;
}

function txRow(r) {
  const open = editTxn === r.id;
  const cat = r.categoryId ? `${catIcon(r.categoryId)} ${catName(r.categoryId)}` : '❓ 미분류';
  const note = [cat, r.cardName, r.counted ? '' : '예산 제외',
                ...(r.tags || []).map((t) => `#${t}`), r.memo].filter(Boolean).join(' · ');

  let h = `<button type="button" class="tx${r.counted ? '' : ' off'}"
    data-tx="${r.id}" aria-expanded="${open}">
    <span class="grow">
      <span class="tx-name">${esc(r.merchantRaw || '(가맹점 미상)')}</span>
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
    <div class="lbl" style="margin-bottom:9px">카테고리 변경</div>
    ${renderPicker(r, null, 'hist', r.categoryId || '')}
    <div class="field" style="margin:13px 0 0"><label>이후 이 가맹점은</label>
      <select data-scope="${r.id}">
        ${scopes.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
      </select></div>
    <label class="check" data-also style="margin:11px 0 0" ${same ? '' : 'hidden'}>
      <input type="checkbox" data-alsopast>
      <span>기존 <b data-alsocount>${same}</b>건도 함께 변경</span></label>`;

  h += `<div class="hr"></div>
    <form data-txn="${r.id}">
      <div class="fields">
        <div class="field"><label>금액</label>
          <input name="amount" inputmode="numeric" value="${won(r.amount)}"></div>
        <div class="field"><label>가맹점</label>
          <input name="merchantRaw" value="${esc(r.merchantRaw || '')}"></div></div>
      <div class="field"><label>태그 <span class="muted" style="font-weight:400">선택</span></label>
        <input name="tags" value="${esc((r.tags || []).join(', '))}"
          placeholder="제주여행, 모임" list="tagList">
        <div class="muted" style="margin-top:6px">쉼표로 구분합니다. 카테고리는 하나, 태그는 여러 개 지정할 수 있습니다.</div></div>
      <div class="field"><label>메모 <span class="muted" style="font-weight:400">선택</span></label>
        <input name="memo" value="${esc(r.memo || '')}" placeholder="내용" maxlength="60"></div>
      <label class="check"><input type="checkbox" name="excludeFromBudget"
        ${r.excludeFromBudget ? 'checked' : ''}> 예산에서 제외 (더치페이 · 환불 등)</label>
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
                     how: '이 가맹점만', cat: m.defaultCategoryId })),
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

  let h = `<div class="muted" style="margin-bottom:12px">문자 수신 시 이 목록 순서로 카테고리를 판정합니다.
      직접 등록한 규칙이 기본 규칙보다 우선합니다.</div>
    <input id="ruleFilter" placeholder="가맹점명 검색" autocomplete="off">
    <div class="lbl" style="margin:16px 0 0">직접 등록한 규칙 · ${mine.length}개</div>`;

  h += mine.length ? mine.map(row).join('')
    : `<div class="empty">등록된 규칙이 없습니다.<br>확인 화면이나 내역에서 카테고리를 지정하면<br>자동으로 등록됩니다.</div>`;

  h += `<details class="mini" style="margin-top:8px">
    <summary>기본 규칙 ${builtin.length}개</summary>
    ${builtin.map(row).join('')}
    <div class="lbl" style="margin:16px 0 0">가맹점명을 신뢰할 수 없는 곳 · ${pass.length}개</div>
    <div class="muted" style="margin-bottom:2px">간편결제는 가맹점명이 대행사로 표시됩니다. 자동 분류하지 않고 매번 확인합니다.</div>
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
  let h = renderPaste() + renderCheck();

  if (found.length) {
    h += `<div class="lbl" style="margin:2px 0 4px">고정지출로 보이는 항목 · ${found.length}건</div>
      <div class="muted" style="margin-bottom:9px">매월 같은 곳에 같은 금액이 출금되고 있습니다. 등록하면 상환 여력이 정확해집니다.</div>`;
    for (const f of found.slice(0, 6)) {
      h += `<div class="card">
        <div class="row" style="align-items:flex-start">
          <span class="grow"><span style="font-size:15px;font-weight:600">${esc(f.name)}</span><br>
            <span class="muted">${f.months.length}개월 연속 · 매월 ${f.dayOfMonth}일경${
              f.spread ? ` (최대 ${f.spread}일 지연)` : ''}</span></span>
          <span class="big num" style="font-size:20px">${won(f.expectedAmount)}</span></div>
        <div class="muted" style="margin-top:9px">${
          f.months.map((m, i) => `${Number(m.split('-')[1])}월 <span class="num">${won(f.amounts[i])}</span>`).join(' · ')}${
          f.varies ? ' — 금액 변동 있음 (평균값으로 등록)' : ''}</div>
        <div style="display:flex;gap:7px;margin-top:13px">
          <button type="button" class="act primary" style="flex:1"
            data-addfixed="${esc(f.key)}">고정지출로 등록</button>
          <button type="button" class="act ghost" data-nofixed="${esc(f.key)}">해당 없음</button>
        </div></div>`;
    }
  }

  if (cancels.length) {
    h += `<div class="lbl" style="margin:2px 0 9px">취소 대상 결제 확인 · ${cancels.length}건</div>`;
    for (const c of cancels) {
      const { candidates } = findOriginal(c, D.txns);
      h += `<div class="card">
        <div class="row" style="align-items:flex-start">
          <span class="grow"><span style="font-size:15px;font-weight:600">취소 — ${esc(c.merchantRaw || '가맹점 미상')}</span><br>
            <span class="muted">${esc(String(c.occurredAt).replace('T', ' ').slice(5, 16))}${c.cardName ? ' · ' + esc(c.cardName) : ''}</span></span>
          <span class="big num" style="font-size:22px">${won(c.amount)}</span></div>`;

      if (!candidates.length) {
        h += `<div class="note warn" style="margin:13px 0 0">같은 금액의 결제를 찾지 못했습니다.<br>
          원결제가 아직 수신되지 않았거나 다른 카드일 수 있습니다.</div>
          <button type="button" class="act ghost" style="width:100%;margin-top:9px"
            data-dropcancel="${c.id}">이 취소 건 보류</button></div>`;
        continue;
      }

      h += `<div class="muted" style="margin:13px 0 7px">상계할 결제를 선택하세요</div>`;
      for (const o of candidates.slice(0, 5)) {
        const days = Math.round((new Date(c.occurredAt) - new Date(o.occurredAt)) / 86400000);
        h += `<button type="button" class="item" style="width:100%;text-align:left;background:none;border-top:0;border-left:0;border-right:0;cursor:pointer"
          data-offset="${c.id}:${o.id}">
          <span class="grow"><span style="font-size:13.5px;font-weight:600">${esc(o.merchantRaw || '(가맹점 미상)')}</span><br>
            <span class="muted">${esc(String(o.occurredAt).slice(5, 10))} · ${days === 0 ? '같은 날' : `${days}일 전`}${o.categoryId ? ' · ' + esc(catName(o.categoryId)) : ''}</span></span>
          <span class="num" style="font-size:14px;font-weight:600">${won(o.amount)}</span></button>`;
      }
      h += `<button type="button" class="act ghost" style="width:100%;margin-top:11px"
        data-dropcancel="${c.id}">해당 없음</button></div>`;
    }
  }

  if (!pending.length && !unparsed.length && !cancels.length && !found.length) {
    $('inbox').innerHTML = h
      + `<div class="card"><div class="empty">확인할 내역이 없습니다.<br>분류되지 않은 결제가 생기면 여기에 표시됩니다.</div></div>`;
    return;
  }

  if (pending.length) {
    h += `<div class="lbl" style="margin:${cancels.length || found.length ? 18 : 2}px 0 9px">카테고리 지정 · ${pending.length}건</div>`;
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
          같은 위치에서 ${decision.nearby.samples}회 결제한 기록이 있습니다</div>`;
      }

      h += renderPicker(t, decision.nearby?.categoryId);

      h += `<div class="hr"></div>
        <div class="field" style="margin:0"><label>이후 이 가맹점은</label>
          <select data-scope="${t.id}">
          ${scopeOptions(t.merchantRaw, hint).map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
          </select></div></div>`;
    }
  }

  if (unparsed.length) {
    h += `<div class="lbl" style="margin:18px 0 9px">인식하지 못한 문자 · ${unparsed.length}건</div>`;
    for (const r of unparsed) {
      h += `<form class="card" data-raw="${r.id}">
        <div class="raw">${esc(r.body)}</div>
        ${r.parseNote ? `<div class="muted" style="margin-top:8px">${esc(r.parseNote)}</div>` : ''}
        <div class="fields" style="margin-top:12px">
          <div class="field" style="margin:0"><label>금액</label>
            <input name="amount" inputmode="numeric" placeholder="9,900"></div>
          <div class="field" style="margin:0"><label>가맹점</label>
            <input name="merchant" placeholder="가맹점"></div></div>
        <div class="field"><label>카테고리</label>
          <select name="categoryId">${catOptions()}</select></div>
        <div style="display:flex;gap:7px">
          <button type="submit" class="act primary" style="flex:1">내역으로 등록</button>
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
/**
 * 문자 붙여넣기.
 *
 * 놓친 문자를 한 건씩 공유하려면 열 건이면 열 번이다. 문자 앱에서 여러 통을
 * 골라 복사해 통째로 붙여 넣으면 알아서 갈린다.
 */
function renderPaste() {
  return `<details class="fold" data-fold="paste" ${openFold.has('paste') ? 'open' : ''}>
    <summary><span class="fold-t">문자 붙여넣기</span>
      <span class="fold-s">누락 결제 보완</span><span class="fold-x"></span></summary>
    <div class="fold-b">
      <div class="muted" style="margin-bottom:11px">메시지 앱에서 문자를 복사해 붙여 넣으세요. 여러 통을 한 번에 넣어도 자동으로 분리되며,
        이미 등록된 건은 제외됩니다.</div>
      <form data-form="paste">
        <div class="field"><label>문자 원문</label>
          <textarea name="body" rows="5" placeholder="[Web발신]&#10;현대 이마트Plus 승인&#10;1,800원 일시불&#10;…"
            style="width:100%;font:inherit;font-size:14px;padding:11px 12px;background:#fff;
                   border:1px solid #D3DCE6;border-radius:10px;resize:vertical"></textarea></div>
        <button type="submit" class="act primary" style="width:100%">등록</button>
      </form></div></details>`;
}

/**
 * 문자에 찍힌 숫자와 우리가 센 숫자를 맞춰 본다.
 *
 * 놓친 걸 놓친 줄 모르는 게 제일 나쁘다. 합계가 조용히 틀려 있으니까.
 * 카드 문자의 누적과 은행 문자의 잔액은 카드사·은행이 센 숫자라 진실이다.
 */
function renderCheck() {
  const cards = cardCheck({ anchors: D.anchors, transactions: D.txns, accounts: D.accounts })
    .filter((c) => !c.ok);
  const banks = balanceCheck({ anchors: D.anchors, accounts: D.accounts })
    .filter((b) => b.stale && !b.ok);
  if (!cards.length && !banks.length) return '';

  let h = '';
  for (const c of cards) {
    h += `<div class="card">
      <div class="row"><span class="lbl grow">${esc(c.name)} — 카드사 기록과 다름</span></div>
      <div class="row" style="padding:7px 0">
        <span class="grow" style="font-size:13px;color:var(--ink2)">카드사 누적</span>
        <span class="num" style="font-size:14px;font-weight:600">${won(c.reported)}</span></div>
      <div class="row" style="padding:7px 0">
        <span class="grow" style="font-size:13px;color:var(--ink2)">앱에서 집계한 금액</span>
        <span class="num" style="font-size:14px;font-weight:600">${won(c.counted)}</span></div>
      ${/* 카드사 누적에는 지난달에서 넘어온 이월잔액이 얹혀 있다. 빼 두지 않으면
           그만큼이 통째로 "놓친 결제"로 보인다. */''}
      ${c.carried ? `<div class="row" style="padding:7px 0">
        <span class="grow" style="font-size:13px;color:var(--ink2)">리볼빙 이월 (지난달에서 넘어옴)</span>
        <span class="num" style="font-size:14px;font-weight:600">${won(c.carried)}</span></div>` : ''}
      <div class="hr"></div>
      <div class="row">
        <span class="grow" style="font-size:13.5px;font-weight:600">${c.missing ? '미수신 결제' : '과다 집계'}</span>
        <span class="big num" style="font-size:22px;color:var(--warn-mark)">${won(Math.abs(c.gap))}</span></div>
      <div class="note ${c.missing ? 'warn' : 'ok'}" style="margin:13px 0 0">${c.missing
        ? `문자가 수신되지 않은 결제가 <b class="num">${won(c.missing)}</b> 있습니다.
           위에서 해당 문자를 붙여 넣으면 보완됩니다.`
        : `앱에 <b class="num">${won(c.extra)}</b>이 더 집계돼 있습니다.
           취소 건이 반영되지 않았거나 같은 결제가 중복 등록됐을 수 있습니다.`}
        <br><span class="muted">${esc(String(c.at).slice(5, 16).replace('T', ' '))} 문자 기준</span></div>
      </div>`;
  }

  for (const b of banks) {
    h += `<div class="card">
      <div class="row"><span class="lbl grow">${esc(b.name)} 잔액이 최신이 아님</span></div>
      <div class="row" style="padding:9px 0">
        <span class="grow" style="font-size:13px;color:var(--ink2)">문자에 표시된 잔액</span>
        <span class="num" style="font-size:16px;font-weight:700">${won(b.reported)}</span></div>
      <div class="row" style="padding:0 0 9px">
        <span class="grow" style="font-size:13px;color:var(--ink2)">앱에 등록된 잔액</span>
        <span class="num" style="font-size:14px;font-weight:600;color:var(--ink3)">${won(b.held)}</span></div>
      <button type="button" class="act primary" style="width:100%"
        data-syncbal="${b.accountId}:${b.reported}">문자 기준으로 갱신</button>
      <div class="muted" style="margin-top:9px">${esc(String(b.at).slice(5, 16).replace('T', ' '))} 수신 문자 기준입니다.</div></div>`;
  }
  return h;
}

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
    out.push(`전체: ${hint.keyword}`);
  }
  if (normalized) out.push(`이 가맹점만: ${normalized}`);
  out.push('이번만 적용');
  return out;
}

function renderFixed() {
  const list = [...D.recurring].sort((a, b) => (a.dayOfMonth || 0) - (b.dayOfMonth || 0));
  // 연 1회짜리는 열두 달로 나눠 얹는다. 나가는 달에만 세면 나머지 열한 달은
  // 돈이 있는 줄 안다.
  const total = monthlyFixed(list);
  const status = new Map(fixedState().map((r) => [r.id, r]));

  const yearly = list.filter((r) => r.period === 'yearly');
  let h = `<div class="card"><div class="lbl">월 고정지출</div>
    <div class="big num" style="font-size:34px;margin:9px 0 6px">₩${won(Math.round(total))}</div>
    <div class="muted">연 <b class="num" style="color:var(--down)">₩${won(Math.round(total * 12))}</b>${
      yearly.length ? ` · 연 1회 ${yearly.length}건을 12개월로 나눠 반영` : ''}</div></div>`;

  h += '<div class="card">';
  if (!list.length) {
    h += `<div class="empty">등록된 고정지출이 없습니다.<br>구독 · 통신비 · 보험료를 등록하면<br>상환 여력이 정확해집니다.</div>`;
  } else {
    for (const r of list) {
      const st = status.get(r.id);
      const dead = r.active === false;
      h += `<div class="item"${dead ? ' style="opacity:.55"' : ''}>
        <span class="muted num" style="width:34px">${r.period === 'yearly'
          ? `${r.monthOfYear || 1}월` : (r.dayOfMonth ? r.dayOfMonth + '일' : '—')}</span>
        <span class="grow"><span style="font-size:13.5px;font-weight:500${
          dead ? ';text-decoration:line-through' : ''}">${esc(r.name)}</span>
          ${fixedNote(r, st)}</span>
        <span class="num" style="font-size:13.5px;font-weight:600">${
          r.amountVaries ? '약 ' : ''}${won(r.expectedAmount)}</span>
        <span class="acts">${dead
          ? `<button type="button" class="act ghost small" data-fixback="${r.id}">되살리기</button>`
          : `<button type="button" class="act ghost small" data-edit="recurring:${r.id}">수정</button>`}
          <button type="button" class="act danger" data-del="recurring:${r.id}">삭제</button></span></div>`;
      if (st) h += fixedAsk(r, st);
    }
  }
  h += '</div>';

  const payOptions = D.accounts.filter((a) => a.active !== false)
    .map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');

  h += `<form class="card" data-form="recurring">
    <div class="lbl" style="margin-bottom:12px">고정지출 등록</div>
    <input type="hidden" name="id">
    <div class="field"><label>이름</label><input name="name" placeholder="넷플릭스" required></div>
    <div class="fields">
      <div class="field"><label>주기</label>
        <select name="period">
          <option value="monthly">매월</option>
          <option value="yearly">연 1회</option></select></div>
      <div class="field" data-rwhen="yearly"><label>결제 월</label>
        <select name="monthOfYear">${Array.from({ length: 12 }, (_, i) =>
          `<option value="${i + 1}">${i + 1}월</option>`).join('')}</select></div></div>
    <div class="fields">
      <div class="field"><label>금액</label><input name="expectedAmount" inputmode="numeric" placeholder="17,000" required></div>
      <div class="field"><label>결제일</label><input name="dayOfMonth" inputmode="numeric" placeholder="5"></div></div>
    <label class="check" style="margin:-2px 0 12px">
      <input type="checkbox" name="amountVaries">
      <span>금액이 매월 달라짐 — 위 금액은 대략치로만 사용</span></label>
    <div class="muted" data-rwhen="yearly" style="margin:-4px 0 12px">
      연 1회 항목은 12개월로 나눠 상환 여력에 반영합니다.</div>

    <div class="hr"></div>
    ${/* 고정지출도 결국 문자로 들어온다. 등록한 항목이 하는 일은 내역을 만드는 게
         아니라 들어온 문자 중에 이것이 있는지 확인하는 것이다. */''}
    <div class="field"><label>결제 수단</label>
      <select name="accountId"><option value="">지정 안 함</option>${payOptions}</select></div>
    <div class="field"><label>문자에서 찾을 단어</label>
      <input name="keywords" placeholder="NETFLIX, 넷플릭스">
      <div class="muted" style="margin-top:6px">문자에 찍히는 이름이 위 이름과 다를 때 사용합니다.
        쉼표로 여러 개를 넣을 수 있습니다.</div></div>
    <div class="field"><label>카테고리</label>
      <select name="categoryId">${catOptions()}</select></div>
    <button type="submit" class="act primary" style="width:100%">등록</button></form>`;

  $('fixed').innerHTML = h;
  // 이 함수는 새로고침 말고 고르기 칸을 여닫을 때도 불린다. 폼을 다시 그렸으니
  // 주기에 따라 숨길 칸도 다시 숨긴다.
  syncRecurringForm();
}

/** 등록한 고정지출이 이번 달에 어디까지 왔는지. */
function fixedState(month) {
  return fixedStatus({
    recurring: D.recurring, transactions: D.txns,
    accounts: D.accounts, settings: D.settings,
  }, month || monthKey(), new Date());
}

const DATE_SHORT = (d) => `${d.getMonth() + 1}월 ${d.getDate()}일`;

/**
 * 안 들어온 고정지출에 묻는 말.
 *
 * 알림에는 끝이 있어야 한다. 물어보기만 하고 치울 길이 없으면 알림은 영영
 * 남고, 남아 있는 알림은 곧 안 보는 알림이 된다. 답은 셋이고 어느 것을 골라도
 * 알림이 사라진다.
 *
 *   해지했습니다   더는 안 나가는 돈이다. 여력 계산에서도 빠진다
 *   출금됐습니다   문자는 놓쳤지만 돈은 나갔다 — 어느 건인지 고른다
 *   이번 달 넘기기 이번 달만 아니다. 다음 달엔 다시 지켜본다
 */
function fixedAsk(r, st) {
  if (st.state === 'skipped') {
    return `<div class="note" style="margin:2px 0 10px">
      이번 달은 넘기기로 했습니다.
      <button type="button" class="act ghost small" style="margin-left:8px"
        data-fixunskip="${r.id}">되돌리기</button></div>`;
  }
  if (st.state !== 'late') return '';

  const picking = fixPick === r.id;
  let h = `<div class="note warn" style="margin:2px 0 10px">
    <b>${DATE_SHORT(st.settled)}에 빠졌어야 합니다.</b> ${st.daysLate}일째 문자가 오지 않았습니다.
    <div class="acts" style="margin-top:9px;justify-content:flex-start;flex-wrap:wrap">
      <button type="button" class="act ${picking ? 'ghost' : 'primary'} small"
        data-fixpick="${r.id}">${picking ? '닫기' : '출금됐습니다'}</button>
      <button type="button" class="act ghost small" data-fixend="${r.id}">해지했습니다</button>
      <button type="button" class="act ghost small" data-fixskip="${r.id}">이번 달 넘기기</button>
    </div>`;

  if (picking) {
    const rows = fixedCandidates(r, D.txns, monthKey(), 6);
    h += `<div class="hr"></div><div class="muted" style="margin-bottom:7px">어느 결제입니까?</div>`;
    h += rows.length
      ? rows.map((t) => `<button type="button" class="pickrow" data-fixlink="${r.id}:${t.id}">
          <span class="grow"><span style="font-size:13px;font-weight:600">${
            esc(t.merchantRaw || '(가맹점 미상)')}</span><br>
            <span class="muted">${esc(String(t.occurredAt).slice(5, 10))}${
              t.cardName ? ' · ' + esc(t.cardName) : ''}</span></span>
          <span class="num" style="font-size:13px;font-weight:600">${won(t.amount)}</span></button>`).join('')
      : `<div class="muted">이 시기에 등록된 지출이 없습니다.</div>`;
    h += `<div class="muted" style="margin-top:9px">목록에 없으면 문자를 먼저 등록하세요 —
      확인 탭의 <b>문자 붙여넣기</b>, 또는 <b>+</b> 로 직접 입력.</div>`;
  }
  return h + '</div>';
}

/** 고정지출 한 줄 아래에 붙는 설명. 상태가 곧 설명이다. */
function fixedNote(r, st) {
  const bits = [];
  if (r.period === 'yearly') {
    bits.push(`연 1회 · 월 <span class="num">${won(Math.round(r.expectedAmount / 12))}</span>`);
  }
  if (!st || st.state === 'idle') {
    if (r.dayOfMonth) return bits.length ? `<br><span class="muted">${bits.join(' · ')}</span>` : '';
    bits.push('결제일 미등록 — 미출금 확인 불가');
    return `<br><span class="muted">${bits.join(' · ')}</span>`;
  }

  if (st.state === 'ended') {
    bits.push('<b>해지함</b> — 지켜보지 않습니다');
    return `<br><span class="muted">${bits.join(' · ')}</span>`;
  }

  if (st.state === 'paid') {
    const at = new Date(st.txn.occurredAt);
    const byHand = st.txn.recurringId === r.id;
    bits.push(`<b style="color:var(--ink2)">${DATE_SHORT(at)} 출금 확인</b>${
      byHand ? ` — <button type="button" class="linkbtn" data-unlink="${st.txn.id}">연결 풀기</button>` : ''}`);
    if (st.diff) {
      bits.push(`등록액보다 <b class="num" style="color:var(--warn-mark)">${
        won(Math.abs(st.diff))}</b> ${st.diff > 0 ? '많음' : '적음'}`);
    }
  } else if (st.state === 'late') {
    bits.push(`<b style="color:var(--warn-mark)">${DATE_SHORT(st.settled)} 예정 · 미확인</b>`);
  } else if (st.state === 'skipped') {
    bits.push(`${DATE_SHORT(st.settled)} 예정 · 이번 달 넘김`);
  } else if (st.state === 'waiting') {
    bits.push(`${DATE_SHORT(st.settled)} 예정${st.shifted ? ' — 휴일이라 이월' : ''}`);
  }
  return `<br><span class="muted">${bits.join(' · ')}</span>`;
}

const ASSET_LABEL = { checking: '입출금', savings: '저축 · 투자', cash: '현금' };

function renderSetup() {
  const s = D.settings;
  const mine = D.merchants.filter((m) => m.defaultCategoryId && !m.isPassthrough && !m.alwaysAsk).length
             + D.rules.filter((r) => r.source === 'learned').length;

  const income = `<form data-form="settings">
    <div class="field"><label>월 수입</label>
      <input name="monthlyIncome" inputmode="numeric" value="${won(s.monthlyIncome)}"></div>
    <div class="field"><label>생활비 예산</label>
      <input name="variableBudget" inputmode="numeric" value="${won(s.variableBudget)}">
      <div class="muted" style="margin-top:6px">고정지출을 제외한 변동 지출 예산입니다.</div></div>
    <div class="hr"></div>
    <div class="fields">
      <div class="field"><label>초기 부채 금액</label>
        <input name="debtStartAmount" inputmode="numeric" value="${won(s.debtStartAmount)}"></div>
      <div class="field"><label>상환 목표일</label>
        <input name="debtTargetDate" type="date" value="${esc(s.debtTargetDate || '')}"></div></div>
    <div class="muted" style="margin:-4px 0 12px">상환 진행률의 기준 금액입니다. 비우면 현재 잔액이 기준이 됩니다.</div>
    <div class="hr"></div>
    <div class="fields">
      <div class="field"><label>결산 시작일</label>
        <select name="cycleStartDay">
          ${Array.from({ length: 28 }, (_, i) => i + 1).map((d) =>
            `<option value="${d}"${Number(s.cycleStartDay || 1) === d ? ' selected' : ''}>${d}일부터</option>`).join('')}
        </select></div>
      <div class="field"><label>휴일에 걸리면</label>
        <select name="cycleMode">
          <option value="calendar"${s.cycleMode !== 'payday' ? ' selected' : ''}>그대로</option>
          <option value="payday"${s.cycleMode === 'payday' ? ' selected' : ''}>앞당김 (급여일 기준)</option>
        </select></div></div>
    <div class="muted" style="margin:-4px 0 12px">
<b>급여일 기준</b>으로 맞추면 사용 가능액이 실제 잔고와 일치합니다.
      급여일이 휴일이면 입금이 앞당겨지므로 주기도 함께 당겨집니다.
      <b>1일</b>로 두면 달력 월 기준이라 지난달과 비교하기 좋습니다.</div>
    <button type="submit" class="act primary" style="width:100%">저장</button></form>`;

  const line = (a, amount, note) => `<div class="item"><span class="grow">
      <span style="font-size:13.5px;font-weight:600">${esc(a.name)}</span><br>
      <span class="muted">${esc(note)}</span></span>
      <span class="num" style="font-size:14px;font-weight:600">${won(amount)}</span>
      <span class="acts">
        <button type="button" class="act ghost small" data-edit="accounts:${a.id}">수정</button>
        <button type="button" class="act danger" data-del="accounts:${a.id}">삭제</button></span></div>`;

  const all = D.accounts.filter((a) => a.active !== false);
  const cashRows = all.filter((a) => ['checking', 'savings', 'cash'].includes(a.type));
  const debtRows = all.filter((a) => debtOf(a) > 0 || a.type === 'loan');
  const cardRows = all.filter((a) => a.type === 'card');

  const money = (cashRows.length
    ? cashRows.map((a) => line(a, cashOf(a),
        [TYPE_LABEL[a.type], Number(a.balance) < 0 ? '마이너스통장 — 부채로 집계' : ''].filter(Boolean).join(' · ')))
        .join('')
    : '<div class="empty">등록된 항목이 없습니다.</div>')
    + `<div class="muted" style="margin-top:10px">통장 잔액은 입출금 문자 수신 시 자동으로 갱신됩니다.
       적금 · 청약처럼 문자가 오지 않는 항목은 직접 입력하세요.</div>`;

  const debts = debtRows.length
    ? debtRows.map((a) => line(a, debtOf(a),
        `${TYPE_LABEL[a.type]} · 연 ${Number(a.rate) || 0}%${a.billingDay ? ` · 매월 ${a.billingDay}일` : ''}`)).join('')
      + `<div class="muted" style="margin-top:10px">이자율을 등록하면 이자가 높은 순으로 상환 순서를 안내합니다.</div>`
    : '<div class="empty">등록된 부채가 없습니다.</div>';

  const cards = (cardRows.length
    ? cardRows.map((a) => line(a, 0,
        `${CARD_LABEL[a.cardType] || '신용'}${a.billingDay ? ` · 매월 ${a.billingDay}일 결제` : ''}${a.issuer ? ` · ${a.issuer}` : ''}`)
        .replace(/<span class="num"[^>]*>0<\/span>/, ''))
      .join('')
    : '<div class="empty">등록된 카드가 없습니다.</div>')
    + `<div class="muted" style="margin-top:10px">카드를 등록하면 다음 결제일의 청구액을 홈에서 확인할 수 있습니다.
       체크카드는 즉시 출금되므로 청구가 발생하지 않습니다.</div>`;

  const bankOptions = all.filter((a) => a.type === 'checking')
    .map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  const cardOptions = cardRows.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  const groupOptions = all.filter((a) => a.type === 'card' || a.type === 'checking')
    .map((a) => `<option value="${a.id}">${esc(a.name)} 와 묶기</option>`).join('');

  const form = `<form data-form="accounts">
    <input type="hidden" name="id">
    <div class="field"><label>종류</label>
      <select name="type">
        <option value="checking">입출금 통장 (마이너스통장 포함)</option>
        <option value="savings">저축 · 투자</option>
        <option value="card">카드</option>
        <option value="loan">부채 — 리볼빙 · 대출</option>
        <option value="cash">현금</option></select></div>
    <div class="field"><label>이름</label>
      <input name="name" placeholder="우리은행 · 현대 이마트Plus · 리볼빙" required></div>

    <div class="fields" data-when="checking savings cash loan">
      <div class="field"><label>잔액</label>
        <input name="balance" inputmode="numeric" placeholder="500,000"></div>
      <div class="field" data-when="checking loan">
        <label id="rateLabel">이자율 (연 %)</label>
        <input name="rate" inputmode="decimal" placeholder="19.9"></div>
      <div class="field" data-when="checking"><label>잔액이 양수일 때 (연 %)</label>
        <input name="ratePlus" inputmode="decimal" placeholder="0.1"></div></div>
    <label class="check" data-when="checking" style="margin:-2px 0 12px">
      <input type="checkbox" name="isMinus">
      <span>현재 마이너스 — 해당 금액이 부채로 집계됩니다</span></label>

    <div class="fields" data-when="card">
      <div class="field"><label>카드 종류</label>
        <select name="cardType">
          <option value="credit">신용</option>
          <option value="debit">체크</option>
          <option value="hybrid">체크 + 신용</option></select></div>
      <div class="field"><label>결제일</label>
        <input name="billingDay" inputmode="numeric" placeholder="10"></div></div>
    <div class="field" data-when="card"><label>출금 통장</label>
      <select name="payFromId"><option value="">지정 안 함</option>${bankOptions}</select></div>
    <div class="field" data-when="card"><label>청구서를 함께 쓰는 카드</label>
      <select name="statementWith"><option value="">별도 청구</option>${groupOptions}</select>
      <div class="muted" style="margin-top:6px">현대카드는 여러 장이어도 <b>누적 사용액을 합산</b>해 표시합니다.
        묶어 두면 청구서 한 장으로 집계되고 대조도 맞습니다.</div></div>

    <label class="check" data-when="card" style="margin:0 0 12px">
      <input type="checkbox" name="revolving">
      <span>리볼빙 사용 중</span></label>
    <div class="fields" data-when="card revolving">
      <div class="field"><label>약정 결제 비율 (%)</label>
        <input name="revolvingRatio" inputmode="numeric" placeholder="30"></div>
      <div class="field"><label>리볼빙 이자율 (연 %)</label>
        <input name="revolvingRate" inputmode="decimal" placeholder="19.9"></div></div>
    <div class="field" data-when="card revolving"><label>현재 이월잔액</label>
      <input name="revolvingBalance" inputmode="numeric" placeholder="2,180,000">
      <div class="muted" style="margin-top:6px">카드사 앱에 표시된 <b>이월잔액</b>입니다. 카드사가 산정하는 금액이라 직접 입력해야 합니다.
        이 금액이 부채로 집계됩니다.</div></div>

    <div class="field" data-when="loan"><label>연결된 카드</label>
      <select name="linkedAccountId"><option value="">연결 없음</option>${cardOptions}</select></div>

    <button type="submit" class="act primary" style="width:100%">저장</button>
    <div class="muted" style="margin-top:10px">위 목록에서 <b>수정</b>을 누르면 여기로 불러옵니다.</div></form>`;

  const ingest = `<form data-form="ingestUrl">
    <div class="muted" style="margin-bottom:10px">아이폰 단축어가 문자를 전송할 주소입니다. 이 화면의 주소와는 다릅니다.</div>
    <div class="field"><label>주소</label>
      <input name="url" inputmode="url" placeholder="https://ingest-xxxx-du.a.run.app"
        value="${esc(ingestUrl())}"></div>
    <div style="display:flex;gap:7px">
      <button type="submit" class="act ghost" style="flex:1">저장</button>
      <button type="button" class="act primary" id="pingIngest" style="flex:1">연결 확인</button>
    </div></form>
    <div class="hr"></div>
    <form data-form="token">
      <div class="muted" style="margin-bottom:12px">단축어는 로그인 없이 동작하므로 미리 정한 비밀번호로 인증합니다.
        이 비밀번호로는 <b>문자 등록만</b> 가능하고 내역을 읽을 수는 없습니다.</div>
      <div class="field"><label>연결 비밀번호</label>
        <input name="token" type="password" autocomplete="new-password" placeholder="8자 이상" required></div>
      <button type="submit" class="act primary" style="width:100%">비밀번호 저장</button>
      <div class="note warn" style="margin:12px 0 0">변경하면 단축어의 <b>token</b> 값도 함께 수정해야 합니다.</div></form>
    <div class="hr"></div>
    <form data-form="widgetToken">
      <div class="muted" style="margin-bottom:12px">위젯이 사용하는 비밀번호입니다. 문자 등록용과 <b>다른 비밀번호</b>를 쓰는 이유는,
        등록용으로 읽기까지 가능해지면 단축어 설정 유출이 곧 전체 내역 유출이 되기 때문입니다.
        이 비밀번호로는 <b>합계 값만</b> 조회되며 가맹점 정보는 전달되지 않습니다.</div>
      <div class="field"><label>위젯 비밀번호</label>
        <input name="widgetToken" type="password" autocomplete="new-password" placeholder="8자 이상" required></div>
      <button type="submit" class="act primary" style="width:100%">위젯 비밀번호 저장</button>
      ${D.ingest?.widgetToken ? '<div class="note ok" style="margin:12px 0 0">설정됨. Scriptable 위젯에 같은 값을 입력하세요.</div>' : ''}
    </form>`;

  const etc = `<div class="muted" style="margin-bottom:10px">엑셀이나 다른 가계부에서 열 수 있는 형식으로 내보냅니다.</div>
    <button type="button" class="act tint" style="width:100%;margin-bottom:9px" id="exportCsv">
      내역 내보내기 (CSV)</button>
    <div style="display:flex;gap:7px">
      <a class="act ghost" href="/data" style="flex:1;text-align:center;text-decoration:none;line-height:22px">원본 데이터</a>
      <button type="button" class="act ghost" id="signout" style="flex:1">로그아웃</button>
    </div>`;

  const cats = expenseCats();
  const net = D.ledger.assets.net;

  // 설정은 한 벌로 늘어놓으면 열한 칸이라 찾을 수가 없다. 큰 갈래로 한 번 묶는다.
  $('setup').innerHTML = [
    group('money', '자산 · 부채', `순자산 ${net < 0 ? '−' : ''}${won(Math.abs(net))}`, [
      fold('assets', '자산',
        cashRows.length ? `${cashRows.length}개 · ${won(D.ledger.assets.total)}` : '미등록', money),
      fold('debts', '부채',
        debtRows.length ? `${debtRows.length}개 · ${won(D.ledger.debt.total)}` : '미등록', debts),
      fold('cards', '카드',
        cardRows.length ? `${cardRows.length}장` : '미등록', cards),
      fold('add', '계좌 · 카드 · 부채 등록', '', form),
    ]),
    group('plan', '계획', s.monthlyIncome ? `월 ${won(s.monthlyIncome)}` : '미설정', [
      fold('goal', '목표', goalSummary(), goalForm()),
      fold('income', '수입과 예산',
        s.monthlyIncome ? `수입 ${won(s.monthlyIncome)} · 생활비 ${won(s.variableBudget)}` : '미등록', income),
      fold('catbudget', '카테고리별 예산',
        D.ledger.byCategory.withLimit.length
          ? `${D.ledger.byCategory.withLimit.length}개 · ${won(D.ledger.byCategory.limitTotal)}`
          : '미설정', renderCategoryBudgets()),
    ]),
    group('sort', '분류', `카테고리 ${cats.length} · 직접 등록 ${mine}`, [
      fold('cats', '카테고리',
        `상위 ${cats.filter((c) => !c.parentId).length} · 하위 ${cats.filter((c) => c.parentId).length}`,
        renderCategories()),
      fold('rules', '자동 분류 규칙', `직접 등록 ${mine}개`, renderRules()),
    ]),
    group('me', '개인 설정', Object.keys(D.shifts).length ? `근무표 ${Object.keys(D.shifts).length}일` : '', [
      fold('shifts', '근무표',
        Object.keys(D.shifts).length ? `${Object.keys(D.shifts).length}일 등록` : '미등록',
        renderShiftForm()),
    ]),
    group('link', '연결', '문자 · 위젯', [
      fold('ingest', '문자 연결', '단축어 전송 주소', ingest),
    ]),
    group('etcg', '기타', '', [
      fold('etc', '내보내기 · 로그아웃', '', etc),
    ]),
  ].join('');
}

/**
 * 설정의 큰 갈래.
 *
 * 접힌 칸이 열한 개면 그것대로 못 찾는다. 한 겹 더 묶어 네댓 개로 줄인다.
 */
function group(key, title, summary, inner) {
  return `<details class="grp" data-fold="g_${key}" ${openFold.has(`g_${key}`) ? 'open' : ''}>
    <summary><span class="grp-t">${esc(title)}</span>
      <span class="fold-s">${esc(summary)}</span><span class="fold-x"></span></summary>
    <div class="grp-b">${inner.join('')}</div></details>`;
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
  expense: { what: '지출처', from: '출금 계좌 · 카드', to: '' },
  income: { what: '수입 내용', from: '', to: '입금 계좌' },
  transfer: { what: '이체 내용', from: '출금 계좌', to: '입금 계좌' },
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
    ? `<option value="">지정 안 함</option>`
      + cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')
    : catOptions();

  const live = D.accounts.filter((a) => a.active !== false);
  const opts = (list, none) => `<option value="">${none}</option>`
    + list.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  form.elements.accountId.innerHTML = opts(live, '지정 안 함');
  form.elements.toAccountId.innerHTML = opts(live, '지정 안 함');
}

/** 통장에 결제일이 있을 리 없고 카드에 이자율이 있을 리 없다. 쓰는 칸만 보인다. */
/** 달마다 나가는 건 "몇 월"을 물을 이유가 없다. */
function syncRecurringForm() {
  const form = document.querySelector('[data-form="recurring"]');
  const period = form?.elements?.period?.value;
  if (!period) return;
  for (const el of form.querySelectorAll('[data-rwhen]')) {
    el.hidden = el.dataset.rwhen !== period;
  }
}

function syncAccountForm() {
  const form = document.querySelector('[data-form="accounts"]');
  const type = form?.elements?.type?.value;
  if (!type) return;
  const revolving = form.elements.revolving?.checked === true;
  const rateLabel = form.querySelector('#rateLabel');
  if (rateLabel) {
    rateLabel.textContent = type === 'checking' ? '잔액이 음수일 때 (연 %)' : '이자율 (연 %)';
  }
  for (const el of form.querySelectorAll('[data-when]')) {
    const want = el.dataset.when.split(' ');
    // "card revolving" 처럼 둘을 함께 적으면 둘 다 맞아야 보인다
    el.hidden = !want.includes(type)
      || (want.includes('revolving') && !revolving);
  }
}

const goalSummary = () => {
  const g = D.ledger.goal;
  if (g.kind === 'keep') return '미설정';
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
    name: '부채 상환',
    startAmount: D.settings.debtStartAmount || 0,
    targetAmount: 0,
    targetDate: D.settings.debtTargetDate || '',
  };
  const pick = (v, label, note) =>
    `<option value="${v}"${g.kind === v ? ' selected' : ''}>${label}${note ? ` — ${note}` : ''}</option>`;

  return `<form data-form="goal">
    <div class="field"><label>목표 종류</label>
      <select name="kind">
        ${pick('payoff', '부채 상환', '0원까지')}
        ${pick('save', '저축', '목표 금액까지')}
        ${pick('keep', '기록만', '목표 없이')}</select></div>
    <div class="field" data-goalwhen="payoff save"><label>이름</label>
      <input name="name" value="${esc(g.name || '')}" placeholder="리볼빙 정리 · 비상금 300만원"></div>
    <div class="fields" data-goalwhen="payoff save">
      <div class="field"><label data-goalstart>시작 금액</label>
        <input name="startAmount" inputmode="numeric" value="${won(g.startAmount)}"></div>
      <div class="field" data-goalwhen="save"><label>목표 금액</label>
        <input name="targetAmount" inputmode="numeric" value="${won(g.targetAmount)}"></div></div>
    <div class="field" data-goalwhen="payoff save"><label>목표 날짜</label>
      <input name="targetDate" type="date" value="${esc(g.targetDate || '')}"></div>
    <div class="muted" data-goalwhen="payoff save" style="margin:-4px 0 12px">
      진행률은 시작 금액 대비로 표시됩니다. 날짜를 지정하면 달성 가능 여부도 안내합니다.</div>

    <div class="hr"></div>
    <label class="check"><input type="checkbox" name="privacy" ${privacyOn() ? 'checked' : ''}>
      <span>금액 가리기 — 화면의 금액을 흐리게 표시하고, 상단 버튼으로 ${PEEK_SECONDS}초간 확인합니다</span></label>
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
  if (label) label.textContent = kind === 'payoff' ? '시작 금액 (초기 부채)' : '시작 금액 (현재 적립액)';
}

function fold(key, title, summary, body) {
  return `<details class="fold" data-fold="${key}" ${openFold.has(key) ? 'open' : ''}>
    <summary><span class="fold-t">${esc(title)}</span>
      <span class="fold-s">${esc(summary)}</span><span class="fold-x"></span></summary>
    <div class="fold-b">${body}</div></details>`;
}

const KIND_LABEL = { expense: '지출', income: '수입', transfer: '이체' };

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

  return renderDutyImport(month) + `<form data-form="shifts">
    <input type="hidden" name="month" value="${month}">
    <div class="muted" style="margin-bottom:12px">
      <b>${Number(y)}년 ${Number(m)}월</b> 근무를 1일부터 순서대로 입력하세요.<br>
      <b>D</b> 데이 · <b>E</b> 이브닝 · <b>N</b> 나이트 · <b>O</b> 오프.
      한글(데 · 이 · 나 · 오)도 가능합니다.</div>
    <div class="field"><label>근무</label>
      <input name="text" value="${esc(now.replace(/·/g, ''))}"
        placeholder="DDEENNOODDEENNOO…" autocapitalize="characters" autocomplete="off"
        style="font-family:ui-monospace,monospace;letter-spacing:2px"></div>
    <div class="muted" style="margin:-4px 0 12px">입력된 근무: <span
      style="font-family:ui-monospace,monospace;letter-spacing:1px">${esc(now)}</span></div>
    <button type="submit" class="act primary" style="width:100%">저장</button>
    <div class="note ok" style="margin:12px 0 0">오전 8시 이전 지출은 <b>전날 근무</b>로 집계합니다.</div></form>`;
}

/**
 * 근무표 앱에서 가져오기.
 *
 * 근무표는 따로 만든 앱에 이미 들어 있다. 한 달에 서른 글자씩 매달 다시 치는
 * 건 낭비고, 손으로 옮기면 하루쯤 밀린 걸 알아채기도 어렵다.
 *
 * 저장 구조를 모른 채로 읽는다 — 나무를 훑어 듀티처럼 생긴 값을 찾고, 그 위
 * 키에서 사람과 달을 읽는다. 읽기만 하고 그쪽 앱에는 아무것도 쓰지 않는다.
 */
function renderDutyImport(month) {
  const url = D.settings.dutyUrl || '';
  const picked = D.settings.dutyPerson || '';

  let h = `<form data-form="duty" style="margin-bottom:14px">
    <div class="field"><label>근무표 앱 주소</label>
      <input name="dutyUrl" type="url" inputmode="url" autocomplete="off"
        placeholder="https://…firebasedatabase.app" value="${esc(url)}">
      <div class="muted" style="margin-top:6px">근무표를 읽어만 옵니다. 그쪽 앱은 바뀌지 않습니다.
        맨 위 주소를 넣으면 전부 뒤지고, <b>…/duties/2026-09</b> 처럼 좁혀 넣으면 그 달만 받습니다.</div></div>
    <div class="acts" style="justify-content:flex-start">
      <button type="submit" class="act ghost small">주소 저장</button>
      ${url ? '<button type="button" class="act primary small" id="dutyLoad">불러오기</button>' : ''}
    </div>`;

  if (dutyFound?.error) {
    h += `<div class="note warn" style="margin:12px 0 0">${esc(dutyFound.error)}</div>`;
  }

  const duties = dutyFound?.duties || [];
  if (dutyFound && !dutyFound.error) {
    const people = dutyPeople(duties);
    if (!people.length) {
      h += `<div class="note warn" style="margin:12px 0 0">근무표를 찾지 못했습니다.
        주소가 맞는지, 읽기가 열려 있는지 확인하세요.</div>`;
    } else {
      // 고른 사람이 목록에 없으면 (이름이 바뀌었거나 처음이면) 제일 많은 사람부터
      const who = people.some((p) => p.person === picked) ? picked : people[0].person;
      h += `<div class="hr"></div>`;
      if (people.length > 1) {
        h += `<div class="field"><label>누구 근무표입니까</label>
          <select data-dutyperson>${people.map((p) =>
            `<option value="${esc(p.person)}"${p.person === who ? ' selected' : ''}>${
              esc(p.person || '이름 없음')} · ${p.months}개월</option>`).join('')}</select></div>`;
      }

      const mine = dutiesOf(duties, who);
      h += `<div class="lbl" style="margin:2px 0 7px">찾은 근무표 ${mine.length}개월</div>`;
      for (const d of mine.slice(0, 12)) {
        const out = toShifts(d.month, d.text);
        const here = d.month === month;
        h += `<div class="item" style="padding:9px 0">
          <span class="grow"><span style="font-size:13px;font-weight:600">${
            Number(d.month.split('-')[1])}월</span>
            <span class="muted" style="font-weight:400"> ${out.count}일치${
              out.ok ? '' : ` · 날수와 ${out.last}일이 안 맞습니다`}</span><br>
            <span class="muted" style="font-family:ui-monospace,monospace;letter-spacing:1px">${
              esc(d.text.slice(0, 31))}</span></span>
          <button type="button" class="act ${here ? 'primary' : 'ghost'} small"
            data-dutyput="${esc(d.month)}">${here ? '이 달 넣기' : '넣기'}</button></div>`;
      }
      if (mine.length > 1) {
        h += `<button type="button" class="act ghost" style="width:100%;margin-top:10px"
          id="dutyPutAll">찾은 ${mine.length}개월 전부 넣기</button>`;
      }
    }
  }
  return h + '</form>';
}

/** 근무표 앱을 읽는다. 여기서 실패하면 이유를 그대로 적어 준다. */
async function loadDuty() {
  const url = dutyEndpoint(D.settings.dutyUrl);
  if (!url) {
    dutyFound = { error: 'https:// 로 시작하는 주소를 먼저 저장하세요' };
    return renderSetup();
  }
  toast('불러오는 중…');
  try {
    // 데이터베이스가 크면 한없이 받고 있을 수 있다. 끊을 줄은 알아야 한다.
    const stop = AbortSignal.timeout ? AbortSignal.timeout(20_000) : undefined;
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: stop });
    if (res.status === 401 || res.status === 403) {
      dutyFound = { error: '근무표 앱이 로그인을 요구합니다 — 읽기 규칙을 확인하세요.' };
    } else if (!res.ok) {
      dutyFound = { error: `불러오지 못했습니다 (${res.status})` };
    } else {
      const tree = await res.json();
      // 주소를 달까지 좁혀 넣었으면 받은 값에는 달이 없다. 주소에서 읽어 넘긴다.
      const month = monthInUrl(D.settings.dutyUrl);
      dutyFound = tree ? { duties: findDuties(tree, { month }) } : { error: '비어 있습니다' };
    }
  } catch (err) {
    dutyFound = { error: err.name === 'TimeoutError'
      ? '20초 안에 응답이 없습니다 — 주소를 「…/duties/2026-09」처럼 좁혀 보세요.'
      : `닿지 못했습니다 — ${err.message}` };
  }
  renderSetup();
}

/** 가져온 달들을 근무표에 넣는다. 그 달 것만 갈아 끼우고 나머지는 둔다. */
async function putDuty(months) {
  const who = D.settings.dutyPerson || dutyPeople(dutyFound?.duties || [])[0]?.person || '';
  const mine = dutiesOf(dutyFound?.duties || [], who)
    .filter((d) => months.includes(d.month));
  if (!mine.length) return toast('넣을 근무표가 없습니다');

  // 이미 넣어 둔 달을 말없이 갈아엎지 않는다. 되돌릴 길이 없는 일이다.
  const over = mine.filter((d) => Object.keys(D.shifts).some((k) => k.startsWith(d.month)));
  if (over.length && !confirm(
    `${over.map((d) => Number(d.month.split('-')[1]) + '월').join(' · ')} 근무표가 이미 있습니다.\n\n`
    + '가져온 것으로 덮어쓸까요? 되돌릴 수 없습니다.')) return;

  let days = { ...D.shifts };
  let count = 0;
  for (const d of mine) {
    const out = toShifts(d.month, d.text);
    days = Object.fromEntries(Object.entries(days).filter(([k]) => !k.startsWith(d.month)));
    days = { ...days, ...out.days };
    count += out.count;
  }
  await setDoc(doc(db, 'users', uid, 'meta', 'shifts'), { days });
  await refresh();

  const off = mine.map((d) => toShifts(d.month, d.text)).filter((o) => !o.ok);
  toast(off.length
    ? `${count}일치를 넣었습니다 — ${off.map((o) => Number(o.month.split('-')[1]) + '월').join(' · ')}은 날수와 안 맞으니 확인하세요`
    : `${mine.length}개월 ${count}일치를 넣었습니다`);
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

  let h = `<div class="muted" style="margin-bottom:12px">예산을 설정한 카테고리는 내역 화면에서 예산 대비로 표시됩니다. 전부 설정할 필요는 없습니다.</div>
    <form data-form="catbudget">`;

  for (const c of mainCats()) {
    const now = Number(used[c.id] || 0);
    h += `<div class="item">
      <span class="grow"><span style="font-size:13.5px;font-weight:600">${esc(c.icon || '')} ${esc(c.name)}</span><br>
        <span class="muted">이번 달 <span class="num">${won(now)}</span></span></span>
      <span class="acts"><input name="${c.id}" inputmode="numeric" placeholder="미설정"
        value="${limits[c.id] ? won(limits[c.id]) : ''}"
        style="width:110px;min-height:38px;font-size:13px;text-align:right"></span></div>`;
  }

  h += `<div class="hr"></div>
    <div class="row" style="margin-bottom:12px">
      <span class="grow" style="font-size:13px;font-weight:600">설정한 예산 합계</span>
      <span class="num" style="font-size:14px;font-weight:700;color:${
        total && sum > total ? 'var(--warn-mark)' : 'var(--ink)'}">${won(sum)}</span></div>
    ${total ? `<div class="muted" style="margin:-6px 0 12px">생활비 예산은 <span class="num">${won(total)}</span>입니다${
      sum > total ? ' — 카테고리별 합계가 더 큽니다.' : '.'}</div>` : ''}
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
        <span class="muted">${used ? `${used}건` : '사용 이력 없음'}${c.id === 'cat_unknown' ? ' · 분류되지 않은 결제가 여기로 집계' : ''}</span></span>
      <span class="acts">
        <button type="button" class="act ghost small" data-editcat="${c.id}">수정</button>
        ${c.id === 'cat_unknown' ? ''
          : `<button type="button" class="act danger" data-delcat="${c.id}">삭제</button>`}</span></div>`;
  };

  let h = `<div class="muted" style="margin-bottom:10px">사용하지 않는 카테고리는 삭제하고 필요한 카테고리를 추가하세요.
    삭제해도 해당 결제는 상위 카테고리로 이동합니다.</div>`;

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
    <div class="lbl" style="margin-bottom:10px">카테고리 등록</div>
    <input type="hidden" name="id">
    <div class="fields">
      <div class="field" style="flex:3"><label>이름</label>
        <input name="name" placeholder="반려동물" required></div>
      <div class="field" style="flex:1"><label>아이콘</label>
        <input name="icon" placeholder="🐾" maxlength="4" style="text-align:center"></div></div>
    <div class="field"><label>상위 카테고리</label>
      <select name="parentId"><option value="">상위 카테고리로 등록</option>
        ${mainCats().map((c) => `<option value="${c.id}">${esc(c.name)} 아래로</option>`).join('')}
      </select></div>
    <div class="field"><label>집계 방식</label>
      <select name="catKind">
        <option value="expense">지출</option>
        <option value="income">수입</option>
        <option value="transfer">이체 (카드 결제 · 저축 등 지출이 아닌 것)</option></select></div>
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
  dropOlder();
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
    learned = `이후 「${keyword}」 자동 분류`;
  } else if (scope === 'exact' && normalized) {
    const id = `mch_${encodeURIComponent(normalized)}`;
    batch.set(doc(col('merchants'), id), {
      id, normalizedName: normalized, displayName: txn.merchantRaw,
      defaultCategoryId: categoryId, isPassthrough: false, alwaysAsk: false,
    });
    learned = '이후 이 가맹점 자동 분류';
  }

  // 규칙을 만들면 밀려 있던 같은 가게 건들도 함께 정리한다.
  // 이미 분류한 건은 일부러 다르게 넣었을 수 있으므로, 시켰을 때만 건드린다.
  const sweepScope = scope === 'once' ? 'exact' : scope;
  const sweepWord = keyword || normalizeMerchant(txn.merchantRaw);
  let also = 0;
  let past = 0;

  if (sweepWord && (scope !== 'once' || alsoPast)) {
    // 지난 건까지 바꾸는 가지다. 여기서 바뀌는 건 말 그대로 옛 거래다.
    dropOlder();
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
         also ? `대기 중이던 ${also}건도 분류` : '',
         past ? `기존 ${past}건도 변경` : '']
    .filter(Boolean).join(' · '));
}

function parseScope(text, merchantRaw) {
  if (text.startsWith('전체:')) return { scope: 'contains', keyword: text.slice(3).trim() };
  if (text.startsWith('이 가맹점만')) return { scope: 'exact', keyword: normalizeMerchant(merchantRaw) };
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
  if (id === 'cat_unknown') return toast('미분류는 삭제할 수 없습니다 — 분류되지 않은 결제가 이곳으로 집계됩니다');

  const kids = D.categories.filter((c) => c.parentId === id && !c.hidden);
  if (kids.length) return toast(`하위 ${kids.length}개를 먼저 옮기거나 삭제하세요`);

  // 안 읽어 온 거래가 이 카테고리를 쓰고 있으면 지워진 칸을 가리킨 채 남는다.
  if (D.hasOlder) await loadAll('카테고리 삭제');

  const to = cat.parentId && D.categories.some((c) => c.id === cat.parentId)
    ? cat.parentId : 'cat_unknown';

  const txns = D.txns.filter((t) => t.categoryId === id);
  const rules = D.rules.filter((r) => r.categoryId === id);
  const shops = D.merchants.filter((m) => m.defaultCategoryId === id);
  const fixed = D.recurring.filter((r) => r.categoryId === id);
  dropOlder();                       // 옛 거래도 이 카테고리를 쓰고 있었을 수 있다
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
    shops.length && `가맹점 규칙 ${shops.length}개`,
    fixed.length && `고정지출 ${fixed.length}개`,
  ].filter(Boolean);

  const msg = parts.length
    ? `「${cat.name}」 을(를) 사용하던 ${parts.join(', ')}가 「${catName(to)}」(으)로 이동합니다.\n\n삭제할까요?`
    : `「${cat.name}」 을(를) 삭제할까요?`;
  if (!confirm(msg)) return;

  await commitAll([
    ...moves,
    (b) => b.delete(doc(col('categories'), id)),
    // 판올림 때 되살아나지 않게 지웠다는 사실을 남긴다
    (b) => b.set(doc(db, 'users', uid, 'meta', 'settings'),
      { removedCategories: [...(D.settings.removedCategories || []), id] }, { merge: true }),
  ]);
  await refresh();
  toast(moves.length ? `삭제했습니다 — ${parts.join(', ')}는 ${catName(to)}(으)로 이동` : '삭제했습니다');
}

async function saveDoc(kind, values) {
  const name = values.name?.trim();
  if (kind !== 'settings' && !name) return toast('이름을 입력하세요');

  if (kind === 'settings') {
    // merge 없이 쓰면 이 폼이 안 건드리는 설정(갈래별 예산 · 안 물어볼 목록 ·
    // 지운 카테고리 · 근무표 주소)까지 통째로 날아간다.
    await setDoc(doc(db, 'users', uid, 'meta', 'settings'), {
      monthlyIncome: parseAmount(values.monthlyIncome) || 0,
      variableBudget: parseAmount(values.variableBudget) || 0,
      debtStartAmount: parseAmount(values.debtStartAmount) || 0,
      debtTargetDate: values.debtTargetDate || '',
      cycleStartDay: Math.min(28, Math.max(1, Number(values.cycleStartDay) || 1)),
      cycleMode: values.cycleMode || 'calendar',
    }, { merge: true });
  } else if (kind === 'accounts') {
    const type = values.type || 'checking';
    const existing = D.accounts.find((a) => a.id === values.id)
      || D.accounts.find((a) => a.name === name);
    const ref = existing ? doc(col('accounts'), existing.id) : doc(col('accounts'));
    const amount = parseAmount(values.balance) || 0;

    // 청구서를 함께 쓰기로 한 상대의 묶음에 들어간다. 상대가 아직 혼자면
    // 상대의 id 가 곧 묶음 이름이 된다.
    const mate = D.accounts.find((a) => a.id === values.statementWith);
    const groupId = type === 'card'
      ? (mate ? (mate.statementGroupId || mate.id) : '')
      : (existing?.statementGroupId || '');

    await setDoc(ref, {
      id: ref.id, name, type,
      // 카드는 잔액을 쓰지 않는다 — 얼마 나갈지는 거래에서 센다.
      // 빚은 갚아야 할 금액이라 늘 양수다. 마이너스통장만 음수를 그대로 둔다.
      // 아이폰 숫자 키패드에는 빼기 기호가 없다. 부호를 치게 하는 대신 물어본다.
      balance: type === 'card' ? 0
        : (type === 'loan' ? Math.abs(amount)
        : (type === 'checking' && values.isMinus === true ? -Math.abs(amount) : Math.abs(amount))),
      rate: Number(values.rate) || 0,
      // 마통이라고 늘 마이너스인 건 아니다. 플러스일 때 받는 이자는 따로 둔다.
      ratePlus: type === 'checking' ? (Number(values.ratePlus) || 0) : 0,
      cardType: type === 'card' ? (values.cardType || 'credit') : '',
      billingDay: Number(values.billingDay) || null,
      payFromId: type === 'card' ? (values.payFromId || '') : '',
      statementGroupId: groupId,
      // 리볼빙은 따로 빌린 돈이 아니라 카드의 성질이다
      revolving: type === 'card' && values.revolving === true,
      revolvingRatio: type === 'card'
        ? Math.min(100, Math.max(1, Number(values.revolvingRatio) || 100)) : 0,
      revolvingRate: type === 'card' ? (Number(values.revolvingRate) || 0) : 0,
      revolvingBalance: type === 'card' && values.revolving === true
        ? Math.abs(parseAmount(values.revolvingBalance) || 0) : 0,
      linkedAccountId: type === 'loan' ? (values.linkedAccountId || '') : '',
      balanceAt: new Date().toISOString(), active: true,
    }, { merge: true });

    // 묶음은 양쪽이 같은 이름을 들고 있어야 한다
    if (mate && groupId && !mate.statementGroupId) {
      await updateDoc(doc(col('accounts'), mate.id), { statementGroupId: groupId });
    }

  } else if (kind === 'categories') {
    const parentId = values.parentId || '';
    const me = D.categories.find((c) => c.id === values.id);
    const parent = D.categories.find((c) => c.id === parentId);
    // 두 단계까지만. 세 단계가 되면 고르는 품이 분류해서 얻는 것보다 커진다.
    if (parent?.parentId) return toast('하위의 하위는 만들 수 없습니다');
    if (me && parentId === me.id) return toast('자기 자신 아래로는 넣을 수 없습니다');
    if (me && parentId && D.categories.some((c) => c.parentId === me.id && !c.hidden)) {
      return toast('하위가 있는 카테고리는 다른 카테고리 밑으로 옮길 수 없습니다');
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
    const period = values.period === 'yearly' ? 'yearly' : 'monthly';
    await setDoc(ref, {
      id: ref.id, name, period,
      monthOfYear: period === 'yearly' ? (Number(values.monthOfYear) || 1) : null,
      expectedAmount: parseAmount(values.expectedAmount) || 0,
      // 통신비처럼 달마다 금액이 바뀌는 건은 위 금액이 대략치다. 금액을 견주지 않는다.
      amountVaries: values.amountVaries === true,
      dayOfMonth: Number(values.dayOfMonth) || null,
      categoryId: values.categoryId || null,
      // 문자 중에 이 항목을 찾아내는 단서
      accountId: values.accountId || '',
      keywords: parseKeywords(values.keywords),
    });
  }

  await refresh();
  toast('저장했습니다');
}

/**
 * 수집 창구를 실제로 두드려 본다.
 *
 * 토큰 없이 보내면 함수가 unauthorized 로 되받는데, 그 대답이 오는 것 자체가
 * 주소가 살아 있다는 뜻이다. 주소를 손으로 옮겨 적기 전에 확인하는 게 낫다.
 */
/** 내보내기. 파일로 떨어뜨려 놓으면 어디서든 연다. */
async function exportCsv() {
  // 반쪽짜리 파일을 내보내면 받은 사람은 그게 전부인 줄 안다.
  if (D.hasOlder) await loadAll('내보내기');
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
  toast(`${D.txns.length}건을 내보냈습니다`);
}

async function pingIngest() {
  if (!ingestUrl()) return toast('주소를 먼저 저장하세요');
  toast('확인 중…');
  try {
    const res = await fetch(ingestUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: '__ping__', body: '' }),
    });
    const data = await res.json().catch(() => ({}));

    if (data.reason === 'unauthorized') return toast('✅ 주소가 정상입니다');
    if (data.reason === 'no-token') return toast('주소는 정상 — 아래에서 비밀번호를 먼저 저장하세요');
    if (data.reason === 'not-set-up') return toast('주소는 정상 — 사용자가 연결되지 않았습니다');
    if (res.status === 403) return toast('❌ 함수가 비공개 상태입니다');
    if (res.status === 404) return toast('❌ 주소를 찾지 못했습니다 — 배포 상태를 확인하세요');
    return toast(`응답: ${res.status} ${data.reason || ''}`);
  } catch (err) {
    toast(`❌ 연결 실패 — ${err.message}`);
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
      if (msg.includes('permission-denied')) toast('권한이 없습니다 — 보안 규칙을 확인하세요');
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

  if (e.target.id === 'loadAll') return loadAll();

  const month = e.target.closest('[data-month]');
  if (month) {
    histMonth = shiftMonth(histMonth || D.ledger.month, Number(month.dataset.month));
    histOpen = null;
    editTxn = null;
    // 읽어 온 창 밖으로 넘어가면 그 달은 무조건 0원으로 보인다. 그건 답이 아니다.
    if (D.hasOlder && `${histMonth}-01T00:00:00` < String(D.from)) await loadAll('지난 달 보기');
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
    return toast('처리했습니다');
  }

  const syncBal = e.target.closest('[data-syncbal]');
  if (syncBal) {
    const [id, value] = syncBal.dataset.syncbal.split(':');
    await updateDoc(doc(col('accounts'), id), {
      balance: Number(value) || 0,
      balanceAt: new Date().toISOString(),
    });
    await refresh();
    return toast('문자 기준으로 갱신했습니다');
  }

  // 안 들어온 고정지출에 답하기 — 어느 답이든 알림이 사라진다
  const fixPickBtn = e.target.closest('[data-fixpick]');
  if (fixPickBtn) {
    const id = fixPickBtn.dataset.fixpick;
    fixPick = fixPick === id ? null : id;
    return renderFixed();
  }

  const fixLink = e.target.closest('[data-fixlink]');
  if (fixLink) {
    const [rid, tid] = fixLink.dataset.fixlink.split(':');
    const r = D.recurring.find((x) => x.id === rid);
    const t = D.txns.find((x) => x.id === tid);
    if (!r || !t) return;

    // 이름이 안 맞아서 못 찾은 것이라면 이번 한 번으로 끝낼 일이 아니다.
    // 다음 달에도 같은 이름으로 올 테니 키워드로 배워 둔다.
    const words = parseKeywords(r.keywords);
    const learn = normalizeMerchant(t.merchantRaw);
    const known = learn && (normalizeMerchant(r.name) && learn.includes(normalizeMerchant(r.name))
      || words.some((w) => learn.includes(normalizeMerchant(w))));
    const next = !known && learn ? [...words, t.merchantRaw.trim()] : words;

    const batch = writeBatch(db);
    dropOlder();
    batch.update(doc(col('txns'), tid), { recurringId: rid });
    if (next !== words) batch.update(doc(col('recurring'), rid), { keywords: next });
    await batch.commit();

    fixPick = null;
    await refresh();
    return toast(next !== words
      ? `${r.name} 에 이었습니다 — 「${t.merchantRaw}」를 찾을 단어로 등록했습니다`
      : `${r.name} 에 이었습니다`);
  }

  const fixEnd = e.target.closest('[data-fixend]');
  if (fixEnd) {
    const r = D.recurring.find((x) => x.id === fixEnd.dataset.fixend);
    if (!r || !confirm(`${r.name} 을(를) 해지한 것으로 둘까요?\n\n더는 지켜보지 않고 월 고정지출에서도 빠집니다.\n지난 내역은 그대로 남습니다.`)) return;
    await updateDoc(doc(col('recurring'), r.id), { active: false, endedAt: new Date().toISOString() });
    await refresh();
    return toast(`${r.name} 을(를) 해지 처리했습니다`);
  }

  const fixBack = e.target.closest('[data-fixback]');
  if (fixBack) {
    await updateDoc(doc(col('recurring'), fixBack.dataset.fixback), { active: true, endedAt: null });
    await refresh();
    return toast('다시 지켜봅니다');
  }

  const fixSkip = e.target.closest('[data-fixskip]');
  if (fixSkip) {
    const r = D.recurring.find((x) => x.id === fixSkip.dataset.fixskip);
    if (!r) return;
    const months = [...new Set([...(r.skipMonths || []), monthKey()])];
    await updateDoc(doc(col('recurring'), r.id), { skipMonths: months });
    fixPick = null;
    await refresh();
    return toast('이번 달은 넘깁니다 — 다음 달에 다시 확인합니다');
  }

  const fixUnskip = e.target.closest('[data-fixunskip]');
  if (fixUnskip) {
    const r = D.recurring.find((x) => x.id === fixUnskip.dataset.fixunskip);
    if (!r) return;
    await updateDoc(doc(col('recurring'), r.id),
      { skipMonths: (r.skipMonths || []).filter((m) => m !== monthKey()) });
    await refresh();
    return toast('다시 지켜봅니다');
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
      amountVaries: Boolean(f.varies),
      active: true,
      source: 'detected',
    });
    await refresh();
    return toast(`${f.name} 을(를) 고정지출로 등록했습니다`);
  }

  const noFixed = e.target.closest('[data-nofixed]');
  if (noFixed) {
    await setDoc(doc(db, 'users', uid, 'meta', 'settings'), {
      ignoredRecurring: [...(D.settings.ignoredRecurring || []), noFixed.dataset.nofixed],
    }, { merge: true });
    await refresh();
    return toast('다시 묻지 않습니다');
  }

  const offset = e.target.closest('[data-offset]');
  if (offset) {
    const [cancelId, originalId] = offset.dataset.offset.split(':');
    const c = D.txns.find((t) => t.id === cancelId);
    const o = D.txns.find((t) => t.id === originalId);
    if (!c || !o) return;
    dropOlder();
    await commitAll([
      (b) => b.update(doc(col('txns'), o.id), voidPatch(c)),
      (b) => b.update(doc(col('txns'), c.id), settledPatch(o)),
    ]);
    await refresh();
    return toast(`${o.merchantRaw || '해당 결제'} 를 취소 처리했습니다`);
  }

  const dropCancel = e.target.closest('[data-dropcancel]');
  if (dropCancel) {
    dropOlder();
    await updateDoc(doc(col('txns'), dropCancel.dataset.dropcancel),
      { status: 'settled', offsetsId: 'none' });
    await refresh();
    return toast('처리했습니다 — 통계에서 제외됩니다');
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
    return toast(`${c.name} 을(를) 불러왔습니다 — 수정 후 저장하세요`);
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
        form.elements.revolving.checked = row.revolving === true;
        form.elements.revolvingBalance.value = row.revolvingBalance ? won(row.revolvingBalance) : '';
        const key = row.statementGroupId;
        const mate = key && D.accounts.find((a) => a.id !== row.id && (a.statementGroupId || a.id) === key);
        form.elements.statementWith.value = mate ? mate.id : '';
        syncAccountForm();
      }
      if (kind === 'recurring') {
        form.elements.amountVaries.checked = row.amountVaries === true;
        form.elements.keywords.value = parseKeywords(row.keywords).join(', ');
        form.elements.expectedAmount.value = won(row.expectedAmount);
        syncRecurringForm();
      }
      const box = form.closest('.fold');
      if (box && !box.open) box.open = true;
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast(`${row.name} 을(를) 불러왔습니다 — 수정 후 저장하세요`);
    }
    return;
  }

  const del = e.target.closest('[data-del]');
  if (del && confirm('삭제할까요?')) {
    const [name, id] = del.dataset.del.split(':');
    // 이어 붙여 둔 거래를 안 풀어 주면 없어진 고정지출을 가리킨 채 남는다.
    // 그 거래는 어느 고정지출로도 안 잡히고 다시 이을 수도 없게 된다.
    if (name === 'recurring') await unlinkAll(id);
    await deleteDoc(doc(col(name), id));
    if (name === 'txns') { editTxn = null; dropOlder(); }
    await refresh();
    return toast('삭제했습니다');
  }

  // 잘못 이었을 때 푸는 길. 한 번 누르면 되돌릴 수 없는 건 기능이 아니다.
  const unlink = e.target.closest('[data-unlink]');
  if (unlink) {
    await updateDoc(doc(col('txns'), unlink.dataset.unlink), { recurringId: '' });
    dropOlder();
    await refresh();
    return toast('연결을 풀었습니다');
  }

  if (e.target.id === 'dutyLoad') return loadDuty();
  if (e.target.id === 'dutyPutAll') {
    const who = D.settings.dutyPerson || dutyPeople(dutyFound?.duties || [])[0]?.person || '';
    return putDuty(dutiesOf(dutyFound?.duties || [], who).map((d) => d.month));
  }
  const dutyPut = e.target.closest('[data-dutyput]');
  if (dutyPut) return putDuty([dutyPut.dataset.dutyput]);

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

  if (e.target.id === 'refresh') { await refresh(); return toast('새로 불러왔습니다'); }
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

  if (e.target.closest('[data-form="accounts"]')
      && ['type', 'revolving'].includes(e.target.name)) {
    return syncAccountForm();
  }
  if (e.target.name === 'period' && e.target.closest('[data-form="recurring"]')) {
    return syncRecurringForm();
  }
  if (e.target.name === 'kind' && e.target.closest('[data-form="goal"]')) {
    return syncGoalForm();
  }

  if (e.target.matches('[data-dutyperson]')) {
    await setDoc(doc(db, 'users', uid, 'meta', 'settings'),
      { dutyPerson: e.target.value }, { merge: true });
    await refresh();
    return renderSetup();
  }

  const sel = e.target.closest('[data-recat]');
  if (!sel) return;
  const [kind, id] = sel.dataset.recat.split(':');
  const field = kind === 'merchants' ? 'defaultCategoryId' : 'categoryId';
  await updateDoc(doc(col(kind), id), { [field]: sel.value || null });
  await refresh();
  toast('변경했습니다');
}));

/**
 * 치는 동안에는 입력칸을 건드리지 않는다.
 *
 * 검색은 검색칸 아래만, 규칙 거르기는 줄을 숨기는 것만으로 한다. 입력칸이
 * 든 자리를 다시 그리면 한글 조합이 끊겨 글자가 깨진다.
 */
document.addEventListener('input', (e) => {
  if (e.target.id === 'histSearch') {
    histQuery = e.target.value;
    editTxn = null;
    renderHistory();
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
    if (!amount) return toast('금액을 입력하세요');
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
      { txnId: ref.id, parsedOk: true, parseNote: '직접 입력' });
    await batch.commit();
    await refresh();
    return toast('등록했습니다');
  }

  if (form.dataset.form === 'quick') {
    const amount = Math.abs(parseAmount(values.amount) || 0);
    if (!amount) return toast('금액을 입력하세요');

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
    return toast(`${{ expense: '지출', income: '수입', transfer: '이체' }[kind]} ${won(amount)} 등록했습니다`);
  }

  if (form.dataset.txn) {
    const amount = parseAmount(values.amount);
    if (!amount) return toast('금액을 입력하세요');
    dropOlder();                     // 창 밖의 옛 거래를 고쳤을 수도 있다
    await updateDoc(doc(col('txns'), form.dataset.txn), {
      amount,
      merchantRaw: String(values.merchantRaw || '').trim(),
      tags: parseTags(values.tags),
      memo: String(values.memo || '').trim().slice(0, 60),
      excludeFromBudget: values.excludeFromBudget === true,
    });
    await refresh();
    return toast('수정했습니다');
  }

  if (form.dataset.form === 'paste') {
    const body = String(values.body || '').trim();
    if (!body) return toast('문자를 붙여 넣으세요');
    const token = String(D.ingest?.token || '').trim();
    if (!token) return toast('설정에서 문자 연결 비밀번호를 먼저 등록하세요');

    toast('등록 중…');
    const res = await fetch(ingestUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, body }),
    });
    const out = await res.json().catch(() => ({}));
    form.reset();
    await refresh();

    if (out.status === 'batch') {
      return toast([`${out.count}통 중`,
        out.saved ? `${out.saved}건 등록` : '',
        out.duplicate ? `${out.duplicate}건 중복` : '',
        out.failed ? `${out.failed}건 인식 실패` : ''].filter(Boolean).join(' · '));
    }
    if (out.status === 'duplicate') return toast('이미 등록된 문자입니다');
    if (out.status === 'parse_failed') return toast(`인식하지 못했습니다 — ${out.note || ''}`);
    if (out.status === 'ok') return toast(`${out.merchant} ${won(out.amount)} 등록했습니다`);
    return toast(out.message || '등록하지 못했습니다');
  }

  if (form.dataset.form === 'duty') {
    const url = String(values.dutyUrl || '').trim();
    if (url && !/^https:\/\//.test(url)) return toast('https:// 로 시작해야 합니다');
    await setDoc(doc(db, 'users', uid, 'meta', 'settings'), { dutyUrl: url }, { merge: true });
    dutyFound = null;
    await refresh();
    return toast(url ? '저장했습니다 — 불러오기를 누르세요' : '주소를 비웠습니다');
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
      ? `${Number(month.split('-')[1])}월 ${Object.keys(parsed).length}일치를 등록했습니다`
      : '비웠습니다');
  }

  if (form.dataset.form === 'catbudget') {
    const limits = {};
    for (const [id, v] of Object.entries(values)) {
      const n = parseAmount(v) || 0;
      if (n > 0) limits[id] = n;
    }
    await setDoc(doc(db, 'users', uid, 'meta', 'settings'), { categoryBudgets: limits }, { merge: true });
    await refresh();
    return toast(Object.keys(limits).length ? `${Object.keys(limits).length}개 카테고리에 예산을 설정했습니다` : '예산을 모두 삭제했습니다');
  }

  if (form.dataset.form === 'goal') {
    setPrivacy(values.privacy === true);
    const kind = values.kind || 'keep';
    await setDoc(doc(db, 'users', uid, 'meta', 'settings'), {
      goal: {
        kind,
        name: String(values.name || '').trim() || (kind === 'payoff' ? '부채 상환' : '저축'),
        startAmount: parseAmount(values.startAmount) || 0,
        targetAmount: kind === 'save' ? (parseAmount(values.targetAmount) || 0) : 0,
        targetDate: values.targetDate || '',
      },
    }, { merge: true });
    await refresh();
    return toast('저장했습니다');
  }

  if (form.dataset.form === 'ingestUrl') {
    const url = values.url.trim();
    if (url && !/^https:\/\//.test(url)) return toast('https:// 로 시작해야 합니다');
    await setDoc(doc(db, 'config/ingest'), { url }, { merge: true });
    await refresh();
    return toast('저장했습니다');
  }

  if (form.dataset.form === 'widgetToken') {
    const token = values.widgetToken.trim();
    if (token.length < 8) return toast('8자 이상 입력하세요');
    if (/[\s&?#%+/]/.test(token)) return toast('공백과 & ? # % + / 는 사용할 수 없습니다');
    await setDoc(doc(db, 'config/ingest'), { widgetToken: token }, { merge: true });
    form.reset();
    await refresh();
    return toast('저장했습니다 — 위젯 스크립트의 TOKEN 도 수정하세요');
  }

  if (form.dataset.form === 'token') {
    const token = values.token.trim();
    if (token.length < 8) return toast('8자 이상 입력하세요');
    if (/[\s&?#%+/]/.test(token)) return toast('공백과 & ? # % + / 는 사용할 수 없습니다');
    await setDoc(doc(db, 'config/ingest'), { token }, { merge: true });
    form.reset();
    return toast('저장했습니다 — 단축어의 token 도 수정하세요');
  }

  if (form.dataset.form) {
    await saveDoc(form.dataset.form, values);
    if (form.dataset.form !== 'settings') form.reset();
  }
}));

start();
