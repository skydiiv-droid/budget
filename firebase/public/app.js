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

import { ledger } from './shared/ledger.js';
import { classify, suggestKeyword } from './shared/classify.js';
import { normalizeMerchant, parseAmount } from './shared/parse.js';
import { categoryDocs, ruleDocs, merchantDocs, accountDocs, SETTINGS, CAT_VERSION }
  from './shared/seed.js';

const $ = (id) => document.getElementById(id);
const won = (n) => Number(n || 0).toLocaleString('ko-KR');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let db, auth, uid, projectId, D = null;

/** 인박스에서 지금 펼쳐 둔 큰 갈래. 거래마다 따로 기억한다. */
const openMain = new Map();

/**
 * 단축어가 두드릴 주소.
 *
 * 2세대 함수는 Cloud Run 주소를 받으므로 프로젝트 이름만으로 만들어 낼 수 없다.
 * 지금 배포된 주소를 기본값으로 두고, 바뀌면 설정에서 고친다.
 * 주소만으로는 아무것도 못 한다 — 토큰이 있어야 하고, 그마저도 넣기만 된다.
 */
const INGEST_DEFAULT = 'https://ingest-6ygn4mmscq-du.a.run.app';
const ingestUrl = () => D?.ingest?.url || INGEST_DEFAULT;

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

  const batch = writeBatch(db);
  for (const c of categoryDocs()) batch.set(doc(col('categories'), c.id), c, { merge: true });
  batch.set(metaRef, { catVersion: CAT_VERSION }, { merge: true });
  await batch.commit();
}

async function refresh() {
  const [categories, rules, merchants, accounts, debts, recurring, settlements, txns, raw, settingsSnap] =
    await Promise.all([
      readAll('categories'), readAll('rules'), readAll('merchants'), readAll('accounts'),
      readAll('debts'), readAll('recurring'), readAll('settlements'),
      getDocs(query(col('txns'), orderBy('occurredAt', 'desc'), limit(500)))
        .then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))),
      getDocs(query(col('raw'), orderBy('receivedAt', 'desc'), limit(100)))
        .then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))),
      getDoc(doc(db, 'users', uid, 'meta', 'settings')),
    ]);

  const settings = settingsSnap.exists() ? settingsSnap.data() : { ...SETTINGS };
  const ingestSnap = await getDoc(doc(db, 'config/ingest')).catch(() => null);
  const ingest = ingestSnap?.exists() ? ingestSnap.data() : {};
  D = { categories, rules, merchants, accounts, debts, recurring, settlements,
        txns, raw, settings, ingest };
  D.ledger = ledger({ transactions: txns, recurring, settlements, accounts, debts, raw, settings });

  $('boot').hidden = true;
  $('app').hidden = false;
  render();
}

// ───────────────────────────────────────────────── 그리기

function render() {
  const L = D.ledger;
  $('monthLabel').textContent = `${L.month} · ${D.settings.cycleStartDay || 1}일 시작`;

  const waiting = L.inbox.pending + L.inbox.unparsed;
  $('badge').hidden = !waiting;
  $('badge').textContent = waiting > 99 ? '99+' : waiting;

  renderHome();
  renderInbox();
  renderFixed();
  renderSetup();
}

const byOrder = (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
const expenseCats = () => D.categories
  .filter((c) => c.kind === 'expense' && !c.hidden).sort(byOrder);
const mainCats = () => expenseCats().filter((c) => !c.parentId);
const subCats = (parentId) => expenseCats().filter((c) => c.parentId === parentId);
const catName = (id) => D.categories.find((c) => c.id === id)?.name ?? id;
const catIcon = (id) => D.categories.find((c) => c.id === id)?.icon ?? '';

function flowRow(name, amount, color, sign) {
  return `<div class="row" style="padding:5px 0">
    <span class="grow" style="font-size:13.5px;color:var(--ink2)">${name}</span>
    <span class="num" style="font-size:13.5px;font-weight:600;color:${color}">${sign} ${won(amount)}</span>
  </div>`;
}

function renderHome() {
  const { debt, planned, budget, assets, inbox } = D.ledger;
  let h = '';

  if (!debt.total) {
    h += `<div class="card"><div class="empty">아직 등록한 빚이 없어요.<br>
      설정에서 리볼빙·마이너스통장을 넣으면<br>여기에 남은 금액과 다 갚는 시점이 나와요.</div></div>`;
  } else {
    h += `<div class="card">
      <div class="row"><span class="lbl grow">남은 빚</span>
      ${debt.daysToTarget !== null ? `<span class="muted">목표까지 D-${Math.max(0, debt.daysToTarget)}</span>` : ''}</div>
      <div class="big num" style="font-size:42px;color:var(--debt);margin:10px 0 14px">₩${won(debt.total)}</div>
      <div class="bar"><i style="width:${Math.min(100, debt.progressPct)}%;background:var(--flow)"></i></div>
      <div class="muted" style="margin-top:7px">
        <b style="color:var(--flow)">${debt.progressPct}% 갚음</b> · 시작 ₩${won(debt.startAmount)}</div>
      <div class="hr"></div>`;

    debt.items.forEach((d, i) => {
      h += `<div class="row" style="padding:7px 0">
        <span style="width:3px;height:26px;border-radius:2px;background:${i === 0 ? 'var(--debt)' : '#C9C4B8'}"></span>
        <span class="grow"><span style="font-size:13.5px;font-weight:600">${esc(d.name)}</span><br>
          <span class="muted">연 ${Number(d.rate) || 0}%${i === 0 && debt.items.length > 1 ? ' · 먼저 갚기' : ''}</span></span>
        <span class="num" style="font-size:15px;font-weight:600">${won(d.balance)}</span></div>`;
    });
    h += '</div>';

    if (!planned.income) {
      h += `<div class="note warn">매달 들어오는 돈을 아직 안 넣었어요.<br>설정에 넣으면 <b>언제 다 갚는지</b>가 나옵니다.</div>`;
    } else if (debt.paceMonths === null) {
      h += `<div class="note warn"><b>지금은 갚을 여력이 없어요.</b><br>
        고정비나 생활비 예산을 줄이지 않으면 빚이 그대로예요.</div>`;
    } else if (debt.needPerMonth === null) {
      h += `<div class="note ok">이 속도면 <b>${debt.paceMonths}개월</b> 걸려요.
        설정에서 목표 날짜를 정하면 속도가 맞는지 알려드릴게요.</div>`;
    } else if (debt.onTrack) {
      h += `<div class="note ok"><b>이 속도면 ${debt.paceMonths}개월 — 목표 안에 끝나요.</b><br>
        매달 ₩${won(debt.needPerMonth)} 필요, 여력 ₩${won(planned.available)}.</div>`;
    } else {
      h += `<div class="note warn"><b>이 속도면 ${debt.paceMonths}개월 — 목표보다 늦어요.</b><br>
        목표 안에 끝내려면 매달 <b>₩${won(debt.needPerMonth)}</b>을 갚아야 해요.
        지금 여력은 <b>₩${won(planned.available)}</b>, <b>₩${won(debt.shortfall)}</b> 모자랍니다.</div>`;
    }
  }

  if (assets.total || debt.total) {
    h += `<div class="card">
      <div class="row"><span class="lbl grow">순자산</span><span class="muted">가진 돈 − 빚</span></div>
      <div class="big num" style="font-size:30px;margin:9px 0 12px;color:${assets.net >= 0 ? 'var(--ink)' : 'var(--debt)'}">
        ${assets.net < 0 ? '−₩' + won(-assets.net) : '₩' + won(assets.net)}</div>`;
    assets.items.filter((a) => a.balance).forEach((a) => {
      h += `<div class="row" style="padding:5px 0">
        <span class="grow" style="font-size:13px;color:var(--ink2)">${esc(a.name)}</span>
        <span class="num" style="font-size:13.5px;font-weight:600;color:var(--flow)">${won(a.balance)}</span></div>`;
    });
    if (debt.total) {
      h += `<div class="row" style="padding:5px 0">
        <span class="grow" style="font-size:13px;color:var(--ink2)">빚</span>
        <span class="num" style="font-size:13.5px;font-weight:600;color:var(--debt)">− ${won(debt.total)}</span></div>`;
    }
    h += '</div>';
  }

  h += `<div class="card"><div class="lbl" style="margin-bottom:11px">이번 달 계산</div>
    ${flowRow('수입', planned.income, 'var(--flow)', '+')}
    ${flowRow('고정비', planned.fixed, 'var(--debt)', '−')}
    ${flowRow('생활비 예산', planned.variableBudget, 'var(--debt)', '−')}
    <div class="hr"></div>
    <div class="row"><span class="grow" style="font-size:14px;font-weight:600">빚 갚는 데 쓸 돈</span>
      <span class="big num" style="font-size:22px;color:${planned.available >= 0 ? 'var(--flow)' : 'var(--debt)'}">${won(planned.available)}</span>
    </div></div>`;

  if (budget.limit) {
    h += `<div class="card">
      <div class="row"><span class="lbl grow">오늘 쓸 수 있는 돈</span><span class="muted">남은 ${budget.daysLeft}일</span></div>
      <div class="big num" style="font-size:32px;margin:9px 0 12px">₩${won(budget.perDay)}</div>
      <div class="bar"><i style="width:${Math.min(100, budget.usedPct)}%;background:var(--debt)"></i></div>
      <div class="muted" style="margin-top:7px">${budget.usedPct}% 사용 · 쓴 돈 ₩${won(budget.spent)} · 남은 ₩${won(budget.remaining)}</div>
    </div>`;
  }

  if (inbox.pending || inbox.unparsed) {
    h += `<button type="button" class="note warn" data-tab="inbox">
      정리할 게 있어요 — 분류 안 된 결제 <b>${inbox.pending}건</b>, 못 읽은 문자 <b>${inbox.unparsed}건</b><br>
      <span style="text-decoration:underline">정리하러 가기</span></button>`;
  }

  $('home').innerHTML = h;
}

function renderInbox() {
  const pending = D.txns.filter((t) => t.status === 'pendingCategory' && t.type === 'expense');
  const unparsed = D.raw.filter((r) => !r.parsedOk && !r.txnId);
  let h = '';

  if (!pending.length && !unparsed.length) {
    $('inbox').innerHTML = `<div class="card"><div class="empty">정리할 게 없어요.<br>분류하지 못한 결제가 생기면 여기에 쌓입니다.</div></div>`;
    return;
  }

  if (pending.length) {
    h += `<div class="lbl" style="margin:2px 0 9px">어디에 쓴 돈인가요 · ${pending.length}건</div>`;
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
        <div class="field"><label>카테고리</label><select name="categoryId">
          <option value="">고르지 않음</option>
          ${expenseCats().map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
        </select></div>
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
function renderPicker(t, hintedId) {
  const open = openMain.get(t.id);
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
    h += `<button type="button" class="pick"
      ${kids.length ? `data-main="${t.id}:${m.id}" aria-expanded="${open === m.id}"`
                    : `data-pick="${t.id}" data-cat="${m.id}"`}>
      ${esc(m.icon || '')} ${esc(m.name)}</button>`;
  }
  h += '</div>';

  const kids = open ? subCats(open) : [];
  if (kids.length) {
    h += '<div class="subs">';
    for (const c of kids) {
      h += `<button type="button" class="pick" data-pick="${t.id}" data-cat="${c.id}">
        ${esc(c.icon || '')} ${esc(c.name)}</button>`;
    }
    const parent = D.categories.find((x) => x.id === open);
    h += `<button type="button" class="pick" data-pick="${t.id}" data-cat="${open}">
      ${esc(parent?.name || '')} 전체</button>`;
    h += '</div>';
  }
  return h;
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
    <div class="muted">1년이면 <b style="color:var(--debt)">₩${won(total * 12)}</b></div></div>`;

  h += '<div class="card">';
  if (!list.length) {
    h += `<div class="empty">넣어 둔 고정비가 없어요.<br>구독·통신비·보험료를 넣으면<br>빚 갚을 여력이 정확해져요.</div>`;
  } else {
    for (const r of list) {
      h += `<div class="item">
        <span class="muted num" style="width:34px">${r.dayOfMonth ? r.dayOfMonth + '일' : '—'}</span>
        <span class="grow" style="font-size:13.5px;font-weight:500">${esc(r.name)}</span>
        <span class="num" style="font-size:13.5px;font-weight:600">${won(r.expectedAmount)}</span>
        <button type="button" class="act ghost small" data-edit="recurring:${r.id}">고치기</button>
        <button type="button" class="act danger" data-del="recurring:${r.id}">삭제</button></div>`;
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
    <div class="field"><label>카테고리</label><select name="categoryId"><option value="">고르지 않음</option>
      ${expenseCats().map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
    <button type="submit" class="act primary" style="width:100%">추가</button></form>`;

  $('fixed').innerHTML = h;
}

const ASSET_LABEL = { checking: '입출금', savings: '저축 · 투자', cash: '현금' };

function renderSetup() {
  const s = D.settings;
  let h = `<form class="card" data-form="settings">
    <div class="lbl" style="margin-bottom:12px">수입과 예산</div>
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
    <button type="submit" class="act primary" style="width:100%">저장</button></form>`;

  h += '<div class="card"><div class="lbl" style="margin-bottom:6px">빚</div>';
  if (!D.debts.length) h += '<div class="empty">아직 없어요.</div>';
  else {
    for (const d of [...D.debts].sort((a, b) => Number(b.rate || 0) - Number(a.rate || 0))) {
      h += `<div class="item"><span class="grow">
        <span style="font-size:13.5px;font-weight:600">${esc(d.name)}</span><br>
        <span class="muted">연 ${Number(d.rate) || 0}%${d.billingDay ? ` · 매월 ${d.billingDay}일` : ''}</span></span>
        <span class="num" style="font-size:14px;font-weight:600">${won(d.balance)}</span>
        <button type="button" class="act ghost small" data-edit="debts:${d.id}">고치기</button>
        <button type="button" class="act danger" data-del="debts:${d.id}">삭제</button></div>`;
    }
  }
  h += '</div>';

  h += `<form class="card" data-form="debts">
    <div class="lbl" style="margin-bottom:6px">빚 넣기</div>
    <div class="muted" style="margin-bottom:12px">이미 넣은 빚은 위에서 <b>고치기</b> 를 누르면 여기로 불러와요.</div>
    <input type="hidden" name="id">
    <div class="field"><label>이름</label><input name="name" placeholder="리볼빙" required></div>
    <div class="fields">
      <div class="field"><label>잔액</label><input name="balance" inputmode="numeric" placeholder="1,840,000" required></div>
      <div class="field"><label>이자율 (연 %)</label><input name="rate" inputmode="decimal" placeholder="17.9"></div></div>
    <div class="field"><label>결제일</label><input name="billingDay" inputmode="numeric" placeholder="5"></div>
    <button type="submit" class="act primary" style="width:100%">저장</button>
    <div class="muted" style="margin-top:10px">이자율을 넣으면 홈에서 비싼 빚부터 갚으라고 알려줘요.</div></form>`;

  const assets = D.accounts.filter((a) => a.type !== 'card');
  h += `<div class="card"><div class="lbl" style="margin-bottom:6px">가진 돈</div>
    <div class="muted" style="margin-bottom:10px">통장 잔고는 입출금 문자가 올 때마다 알아서 맞춰져요. 적금·청약처럼 문자가 안 오는 건 직접 넣어 주세요.</div>`;
  if (!assets.length) h += '<div class="empty">아직 없어요.</div>';
  else {
    for (const a of assets) {
      h += `<div class="item"><span class="grow">
        <span style="font-size:13.5px;font-weight:600">${esc(a.name)}</span><br>
        <span class="muted">${esc(ASSET_LABEL[a.type] || a.type)}</span></span>
        <span class="num" style="font-size:14px;font-weight:600">${won(a.balance)}</span>
        <button type="button" class="act ghost small" data-edit="accounts:${a.id}">고치기</button>
        <button type="button" class="act danger" data-del="accounts:${a.id}">삭제</button></div>`;
    }
  }
  h += '</div>';

  h += `<form class="card" data-form="accounts">
    <div class="lbl" style="margin-bottom:12px">가진 돈 넣기</div>
    <input type="hidden" name="id">
    <div class="field"><label>이름</label><input name="name" placeholder="우리은행 · 청약 · 적금" required></div>
    <div class="fields">
      <div class="field"><label>잔액</label><input name="balance" inputmode="numeric" placeholder="500,000" required></div>
      <div class="field"><label>종류</label><select name="type">
        <option value="checking">입출금</option><option value="savings">저축 · 투자</option>
        <option value="cash">현금</option></select></div></div>
    <button type="submit" class="act primary" style="width:100%">저장</button></form>`;

  h += `<form class="card" data-form="ingestUrl">
    <div class="lbl" style="margin-bottom:6px">문자 받는 주소</div>
    <div class="muted" style="margin-bottom:10px">이 화면 주소와 달라요. 아이폰 단축어가 문자를 보낼 곳입니다. 바뀌었을 때만 고치면 돼요.</div>
    <div class="field"><label>주소</label>
      <input name="url" inputmode="url" placeholder="https://ingest-xxxx-du.a.run.app"
        value="${esc(ingestUrl())}"></div>
    <div style="display:flex;gap:7px">
      <button type="submit" class="act ghost" style="flex:1">저장</button>
      <button type="button" class="act primary" id="pingIngest" style="flex:1">연결 확인</button>
    </div></form>`;

  h += `<form class="card" data-form="token">
    <div class="lbl" style="margin-bottom:6px">문자 연결 비밀번호</div>
    <div class="muted" style="margin-bottom:12px">아이폰 단축어는 새벽에 주머니 속에서 혼자 돌아 로그인을 할 수 없어요. 그래서 미리 정해 둔 비밀번호로 들어옵니다. 이걸로는 <b>문자를 넣는 것만</b> 되고 가계부를 읽지는 못해요.</div>
    <div class="field"><label>비밀번호</label>
      <input name="token" type="password" autocomplete="new-password" placeholder="8자 이상" required></div>
    <button type="submit" class="act primary" style="width:100%">저장</button>
    <div class="note warn" style="margin:12px 0 0">바꾸면 아이폰 <b>단축어의 token 칸도</b> 같이 고쳐야 문자가 계속 들어와요.</div></form>`;

  h += `<div class="card"><div class="lbl" style="margin-bottom:10px">그 밖에</div>
    <div style="display:flex;gap:7px">
      <a class="act ghost" href="/data" style="flex:1;text-align:center;text-decoration:none;line-height:22px">원본 데이터</a>
      <button type="button" class="act ghost" id="signout" style="flex:1">로그아웃</button>
    </div></div>`;

  $('setup').innerHTML = h;
}

// ───────────────────────────────────────────────── 고치기

const formData = (form) => Object.fromEntries(
  [...form.elements].filter((f) => f.name).map((f) => [f.name, f.value]));

async function pickCategory(txnId, categoryId) {
  const txn = D.txns.find((t) => t.id === txnId);
  if (!txn) return;

  const scopeValue = document.querySelector(`[data-scope="${txnId}"]`)?.value ?? '';
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
  // 이미 분류한 건은 건드리지 않는다 — 일부러 다르게 넣었을 수 있다.
  let also = 0;
  if (scope !== 'once' && keyword) {
    for (const t of D.txns) {
      if (t.id === txnId || t.status !== 'pendingCategory' || t.categoryId) continue;
      const other = normalizeMerchant(t.merchantRaw);
      if (!other) continue;
      const hit = scope === 'contains' ? other.includes(keyword) : other === keyword;
      if (!hit) continue;
      batch.update(doc(col('txns'), t.id), { categoryId, status: 'confirmed' });
      also++;
    }
  }

  await batch.commit();
  await refresh();
  toast([`${catName(categoryId)}(으)로 저장`, learned, also ? `밀려 있던 ${also}건도 정리` : '']
    .filter(Boolean).join(' · '));
}

function parseScope(text, merchantRaw) {
  if (text.startsWith('모두:')) return { scope: 'contains', keyword: text.slice(3).trim() };
  if (text.startsWith('이 가게만')) return { scope: 'exact', keyword: normalizeMerchant(merchantRaw) };
  return { scope: 'once', keyword: '' };
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
      cycleStartDay: D.settings.cycleStartDay || 1,
    });
  } else if (kind === 'debts') {
    const existing = D.debts.find((d) => d.id === values.id) || D.debts.find((d) => d.name === name);
    const ref = existing ? doc(col('debts'), existing.id) : doc(col('debts'));
    await setDoc(ref, {
      id: ref.id, name,
      balance: parseAmount(values.balance) || 0,
      rate: Number(values.rate) || 0,
      billingDay: Number(values.billingDay) || null,
    });
  } else if (kind === 'accounts') {
    const existing = D.accounts.find((a) => a.id === values.id) || D.accounts.find((a) => a.name === name);
    const ref = existing ? doc(col('accounts'), existing.id) : doc(col('accounts'));
    await setDoc(ref, {
      id: ref.id, name, type: values.type || 'savings',
      balance: parseAmount(values.balance) || 0,
      balanceAt: new Date().toISOString(), active: true,
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
    for (const id of ['home', 'inbox', 'fixed', 'setup']) $(id).hidden = id !== tab.dataset.tab;
    document.querySelectorAll('.tabs [data-tab]').forEach((b) => {
      if (b.dataset.tab === tab.dataset.tab) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    window.scrollTo(0, 0);
    return;
  }

  const main = e.target.closest('[data-main]');
  if (main) {
    const [txnId, catId] = main.dataset.main.split(':');
    openMain.set(txnId, openMain.get(txnId) === catId ? null : catId);
    renderInbox();
    return;
  }

  const pick = e.target.closest('[data-pick]');
  if (pick) return pickCategory(pick.dataset.pick, pick.dataset.cat);

  const ignore = e.target.closest('[data-ignore]');
  if (ignore) {
    await updateDoc(doc(col('raw'), ignore.dataset.ignore), { parsedOk: true, parseNote: '거래 아님' });
    await refresh();
    return toast('치웠어요');
  }

  const edit = e.target.closest('[data-edit]');
  if (edit) {
    const [kind, id] = edit.dataset.edit.split(':');
    const table = { debts: D.debts, accounts: D.accounts, recurring: D.recurring }[kind] || [];
    const row = table.find((x) => x.id === id);
    const form = document.querySelector(`[data-form="${kind}"]`);
    if (row && form) {
      for (const field of form.elements) {
        if (!field.name) continue;
        const v = row[field.name];
        field.value = (v === null || v === undefined) ? '' : String(v);
      }
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast(`${row.name} 을(를) 불러왔어요 — 고치고 저장하세요`);
    }
    return;
  }

  const del = e.target.closest('[data-del]');
  if (del && confirm('지울까요?')) {
    const [name, id] = del.dataset.del.split(':');
    await deleteDoc(doc(col(name), id));
    await refresh();
    return toast('지웠어요');
  }

  if (e.target.id === 'pingIngest') return pingIngest();

  if (e.target.id === 'refresh') { await refresh(); return toast('새로 불러왔어요'); }
  if (e.target.id === 'signout') return signOut(auth);
}));



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

  if (form.dataset.form === 'ingestUrl') {
    const url = values.url.trim();
    if (url && !/^https:\/\//.test(url)) return toast('https:// 로 시작해야 해요');
    await setDoc(doc(db, 'config/ingest'), { url }, { merge: true });
    await refresh();
    return toast('저장했어요');
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
