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
import { categoryDocs, ruleDocs, merchantDocs, accountDocs, SETTINGS } from './shared/seed.js';

const $ = (id) => document.getElementById(id);
const won = (n) => Number(n || 0).toLocaleString('ko-KR');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let db, auth, uid, D = null;

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

  const app = initializeApp(config);
  auth = getAuth(app);
  db = getFirestore(app);

  onAuthStateChanged(auth, async (user) => {
    if (!user) return showSignIn();
    uid = user.uid;
    try {
      await claimOwner(user);
      await seedIfEmpty();
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
  D = { categories, rules, merchants, accounts, debts, recurring, settlements, txns, raw, settings };
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

const expenseCats = () => D.categories.filter((c) => c.kind === 'expense')
  .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
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
      설정에서 리볼빙·마이너스통장 잔액을 넣으면<br>
      여기에 남은 금액과 끝나는 시점이 나옵니다.</div></div>`;
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
      h += `<div class="note warn">월 실수령액을 아직 안 넣었어요.
        설정에 넣으면 <b>언제 끝나는지</b>가 계산됩니다.</div>`;
    } else if (debt.paceMonths === null) {
      h += `<div class="note warn"><b>지금은 갚을 여력이 없어요.</b><br>
        고정지출이나 변동 예산을 줄이지 않으면 빚이 줄지 않습니다.</div>`;
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

  h += `<div class="card"><div class="lbl" style="margin-bottom:11px">이번 달 계획</div>
    ${flowRow('수입', planned.income, 'var(--flow)', '+')}
    ${flowRow('고정지출', planned.fixed, 'var(--debt)', '−')}
    ${flowRow('변동 예산', planned.variableBudget, 'var(--debt)', '−')}
    <div class="hr"></div>
    <div class="row"><span class="grow" style="font-size:14px;font-weight:600">갚는 데 쓸 수 있는 돈</span>
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
      손이 필요한 것 — 분류 대기 <b>${inbox.pending}건</b>, 해석 실패 문자 <b>${inbox.unparsed}건</b><br>
      <span style="text-decoration:underline">인박스에서 정리하기</span></button>`;
  }

  $('home').innerHTML = h;
}

function renderInbox() {
  const pending = D.txns.filter((t) => t.status === 'pendingCategory' && t.type === 'expense');
  const unparsed = D.raw.filter((r) => !r.parsedOk && !r.txnId);
  let h = '';

  if (!pending.length && !unparsed.length) {
    $('inbox').innerHTML = `<div class="card"><div class="empty">정리할 게 없어요.<br>
      분류하지 못한 결제가 생기면 여기에 쌓입니다.</div></div>`;
    return;
  }

  if (pending.length) {
    h += `<div class="lbl" style="margin:2px 0 9px">분류가 필요해요 · ${pending.length}건</div>`;
    for (const t of pending) {
      const decision = classify(t.merchantRaw, {
        merchants: D.merchants, rules: D.rules, transactions: D.txns,
        location: t.lat != null ? { lat: t.lat, lon: t.lon } : null,
      });
      const hint = suggestKeyword(t.merchantRaw, { rules: D.rules, transactions: D.txns });
      const top = topCategories(decision);

      h += `<div class="card">
        <div class="row" style="align-items:flex-start">
          <span class="grow"><span style="font-size:15px;font-weight:600">${esc(t.merchantRaw || '(가맹점 미상)')}</span><br>
            <span class="muted">${esc(String(t.occurredAt).replace('T', ' ').slice(5, 16))}${t.cardName ? ' · ' + esc(t.cardName) : ''}</span></span>
          <span class="big num" style="font-size:22px">${won(t.amount)}</span></div>`;

      if (decision.nearby?.samples) {
        h += `<div class="note ok" style="margin:12px 0 0;padding:9px 12px">
          같은 자리에서 ${decision.nearby.samples}번 왔던 곳이에요</div>`;
      }

      h += '<div style="display:flex;flex-wrap:wrap;gap:7px;margin-top:13px">';
      top.forEach((c, i) => {
        h += `<button type="button" class="act ${i === 0 ? 'primary' : 'ghost'}"
          data-pick="${t.id}" data-cat="${c.id}">${esc(c.name)}</button>`;
      });
      h += '</div>';

      h += `<div class="hr"></div><div class="fields">
        <div class="field" style="margin:0"><label>그 밖의 카테고리</label>
          <select data-other="${t.id}"><option value="">고르기…</option>
          ${expenseCats().map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
          </select></div>
        <div class="field" style="margin:0"><label>앞으로</label>
          <select data-scope="${t.id}">
          ${scopeOptions(t.merchantRaw, hint).map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
          </select></div>
      </div></div>`;
    }
  }

  if (unparsed.length) {
    h += `<div class="lbl" style="margin:18px 0 9px">해석하지 못한 문자 · ${unparsed.length}건</div>`;
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

/** 고를 만한 카테고리 셋. 위치로 짚인 것이 있으면 맨 앞에 둔다. */
function topCategories(decision) {
  const counts = new Map();
  for (const t of D.txns) {
    if (t.categoryId) counts.set(t.categoryId, (counts.get(t.categoryId) || 0) + 1);
  }
  const cats = expenseCats()
    .sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0))
    .slice(0, 3);

  const hinted = decision.nearby?.categoryId;
  if (!hinted) return cats;
  const pick = D.categories.find((c) => c.id === hinted);
  if (!pick) return cats;
  return [pick, ...cats.filter((c) => c.id !== hinted)].slice(0, 3);
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
    h += `<div class="empty">등록한 고정지출이 없어요.<br>
      구독·통신비·보험료를 넣으면<br>갚을 여력이 정확해집니다.</div>`;
  } else {
    for (const r of list) {
      h += `<div class="item">
        <span class="muted num" style="width:34px">${r.dayOfMonth ? r.dayOfMonth + '일' : '—'}</span>
        <span class="grow" style="font-size:13.5px;font-weight:500">${esc(r.name)}</span>
        <span class="num" style="font-size:13.5px;font-weight:600">${won(r.expectedAmount)}</span>
        <button type="button" class="act danger" data-del="recurring:${r.id}">삭제</button></div>`;
    }
  }
  h += '</div>';

  h += `<form class="card" data-form="recurring">
    <div class="lbl" style="margin-bottom:12px">고정지출 추가</div>
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
    <div class="lbl" style="margin-bottom:12px">돈의 흐름</div>
    <div class="field"><label>월 실수령액</label>
      <input name="monthlyIncome" inputmode="numeric" value="${won(s.monthlyIncome)}"></div>
    <div class="field"><label>변동지출 예산</label>
      <input name="variableBudget" inputmode="numeric" value="${won(s.variableBudget)}">
      <div class="muted" style="margin-top:6px">고정지출 말고 쓰는 돈. 감으로 잡고 나중에 고쳐도 됩니다.</div></div>
    <div class="hr"></div>
    <div class="fields">
      <div class="field"><label>빚 시작 금액</label>
        <input name="debtStartAmount" inputmode="numeric" value="${won(s.debtStartAmount)}"></div>
      <div class="field"><label>목표 완료일</label>
        <input name="debtTargetDate" type="date" value="${esc(s.debtTargetDate || '')}"></div></div>
    <div class="muted" style="margin:-4px 0 12px">시작 금액은 진행률의 기준점이에요. 비우면 지금 잔액이 기준이 됩니다.</div>
    <button type="submit" class="act primary" style="width:100%">저장</button></form>`;

  h += '<div class="card"><div class="lbl" style="margin-bottom:6px">빚</div>';
  if (!D.debts.length) h += '<div class="empty">아직 없어요.</div>';
  else {
    for (const d of [...D.debts].sort((a, b) => Number(b.rate || 0) - Number(a.rate || 0))) {
      h += `<div class="item"><span class="grow">
        <span style="font-size:13.5px;font-weight:600">${esc(d.name)}</span><br>
        <span class="muted">연 ${Number(d.rate) || 0}%${d.billingDay ? ` · 매월 ${d.billingDay}일` : ''}</span></span>
        <span class="num" style="font-size:14px;font-weight:600">${won(d.balance)}</span>
        <button type="button" class="act danger" data-del="debts:${d.id}">삭제</button></div>`;
    }
  }
  h += '</div>';

  h += `<form class="card" data-form="debts">
    <div class="lbl" style="margin-bottom:6px">빚 추가 · 잔액 고치기</div>
    <div class="muted" style="margin-bottom:12px">같은 이름으로 다시 넣으면 잔액이 바뀝니다.</div>
    <div class="field"><label>이름</label><input name="name" placeholder="리볼빙" required></div>
    <div class="fields">
      <div class="field"><label>잔액</label><input name="balance" inputmode="numeric" placeholder="1,840,000" required></div>
      <div class="field"><label>연 이자율 %</label><input name="rate" inputmode="decimal" placeholder="17.9"></div></div>
    <div class="field"><label>결제일</label><input name="billingDay" inputmode="numeric" placeholder="5"></div>
    <button type="submit" class="act primary" style="width:100%">저장</button>
    <div class="muted" style="margin-top:10px">이자율을 넣으면 비싼 빚부터 갚으라고 홈에서 알려줍니다.</div></form>`;

  const assets = D.accounts.filter((a) => a.type !== 'card');
  h += `<div class="card"><div class="lbl" style="margin-bottom:6px">가진 돈</div>
    <div class="muted" style="margin-bottom:10px">통장 잔고는 입출금 문자가 올 때마다 알아서 맞춰집니다.
    저축·투자는 직접 넣어 주세요.</div>`;
  if (!assets.length) h += '<div class="empty">아직 없어요.</div>';
  else {
    for (const a of assets) {
      h += `<div class="item"><span class="grow">
        <span style="font-size:13.5px;font-weight:600">${esc(a.name)}</span><br>
        <span class="muted">${esc(ASSET_LABEL[a.type] || a.type)}</span></span>
        <span class="num" style="font-size:14px;font-weight:600">${won(a.balance)}</span>
        <button type="button" class="act danger" data-del="accounts:${a.id}">삭제</button></div>`;
    }
  }
  h += '</div>';

  h += `<form class="card" data-form="accounts">
    <div class="lbl" style="margin-bottom:12px">가진 돈 추가 · 고치기</div>
    <div class="field"><label>이름</label><input name="name" placeholder="우리은행 · 청약 · 적금" required></div>
    <div class="fields">
      <div class="field"><label>잔액</label><input name="balance" inputmode="numeric" placeholder="500,000" required></div>
      <div class="field"><label>종류</label><select name="type">
        <option value="checking">입출금</option><option value="savings">저축 · 투자</option>
        <option value="cash">현금</option></select></div></div>
    <button type="submit" class="act primary" style="width:100%">저장</button></form>`;

  h += `<form class="card" data-form="token">
    <div class="lbl" style="margin-bottom:6px">단축어 토큰</div>
    <div class="muted" style="margin-bottom:12px">아이폰 단축어가 문자를 보낼 때 쓰는 열쇠예요.
    사람은 로그인으로 들어오고, 기계는 이 토큰으로 들어옵니다.</div>
    <div class="field"><label>토큰</label>
      <input name="token" type="password" autocomplete="new-password" placeholder="8자 이상" required></div>
    <button type="submit" class="act primary" style="width:100%">저장</button>
    <div class="note warn" style="margin:12px 0 0">바꾸면 <b>단축어의 token 값도</b> 같이 고쳐야 해요.</div></form>`;

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
    const existing = D.debts.find((d) => d.name === name);
    const ref = existing ? doc(col('debts'), existing.id) : doc(col('debts'));
    await setDoc(ref, {
      id: ref.id, name,
      balance: parseAmount(values.balance) || 0,
      rate: Number(values.rate) || 0,
      billingDay: Number(values.billingDay) || null,
    });
  } else if (kind === 'accounts') {
    const existing = D.accounts.find((a) => a.name === name);
    const ref = existing ? doc(col('accounts'), existing.id) : doc(col('accounts'));
    await setDoc(ref, {
      id: ref.id, name, type: values.type || 'savings',
      balance: parseAmount(values.balance) || 0,
      balanceAt: new Date().toISOString(), active: true,
    }, { merge: true });
  } else if (kind === 'recurring') {
    const ref = doc(col('recurring'));
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

// ───────────────────────────────────────────────── 이벤트

document.addEventListener('click', async (e) => {
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

  const pick = e.target.closest('[data-pick]');
  if (pick) return pickCategory(pick.dataset.pick, pick.dataset.cat);

  const ignore = e.target.closest('[data-ignore]');
  if (ignore) {
    await updateDoc(doc(col('raw'), ignore.dataset.ignore), { parsedOk: true, parseNote: '거래 아님' });
    await refresh();
    return toast('치웠어요');
  }

  const del = e.target.closest('[data-del]');
  if (del && confirm('지울까요?')) {
    const [name, id] = del.dataset.del.split(':');
    await deleteDoc(doc(col(name), id));
    await refresh();
    return toast('지웠어요');
  }

  if (e.target.id === 'refresh') { await refresh(); return toast('새로 불러왔어요'); }
  if (e.target.id === 'signout') return signOut(auth);
});

document.addEventListener('change', (e) => {
  const other = e.target.closest('[data-other]');
  if (other?.value) pickCategory(other.dataset.other, other.value);
});

document.addEventListener('submit', async (e) => {
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

  if (form.dataset.form === 'token') {
    const token = values.token.trim();
    if (token.length < 8) return toast('8자 이상으로 해 주세요');
    if (/[\s&?#%+/]/.test(token)) return toast('공백과 & ? # % + / 는 쓸 수 없어요');
    await setDoc(doc(db, 'config/ingest'), { token });
    form.reset();
    return toast('저장했어요 — 단축어의 token 도 고쳐 주세요');
  }

  if (form.dataset.form) {
    await saveDoc(form.dataset.form, values);
    if (form.dataset.form !== 'settings') form.reset();
  }
});

start();
