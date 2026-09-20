/**
 * 문자를 받아 넣는 창구. 아이폰 단축어가 여기로 POST 한다.
 *
 * 사람이 보는 화면은 Firestore 를 직접 읽는다(로그인으로 막힘).
 * 여기는 사람이 아니라 기계가 부르는 곳이라 로그인을 못 하므로 토큰으로 막는다.
 *
 * 토큰은 앱의 설정 화면에서 정한다. 콘솔이나 CLI 를 만질 일이 없도록
 * Firestore 에 두고 여기서 읽는다.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';

import { parseMessage, normalizeMerchant, splitMessages } from './shared/parse.js';
import { classify, suggestKeyword } from './shared/classify.js';
import { ledger, monthSpending, sameSpanLastMonth, pace } from './shared/ledger.js';

initializeApp();
const db = getFirestore();

/** 누가 주인인지. 처음 로그인할 때 앱이 적어 둔다. */
async function ownerUid() {
  const snap = await db.doc('config/owner').get();
  const uid = snap.exists ? snap.data().uid : null;
  if (!uid) throw new HttpError(503, 'not-set-up', '앱에 한 번 로그인해 주세요');
  return uid;
}

async function ingestToken() {
  const snap = await db.doc('config/ingest').get();
  const token = snap.exists ? String(snap.data().token || '').trim() : '';
  if (!token) throw new HttpError(503, 'no-token', '앱 설정에서 수집 토큰을 정해 주세요');
  return token;
}

class HttpError extends Error {
  constructor(status, reason, message) {
    super(message || reason);
    this.status = status;
    this.reason = reason;
  }
}

/**
 * 같은 문자가 두 번 들어와도 한 건으로 본다.
 *
 * 받은 시각은 쓰지 않고 원문만 쓴다. 놓친 문자를 나중에 공유 시트로 보낼 때
 * 받은 시각이 달라지는데, 그것까지 넣으면 같은 결제가 두 건이 되기 때문이다.
 * 원문만으로 충분한 이유: 카드 문자에는 월 누적이, 은행 문자에는 잔액이 함께
 * 찍힌다. 둘 다 거래마다 달라지므로 서로 다른 거래의 원문이 같을 수 없다.
 */
const dedupeId = (body) => createHash('md5').update(String(body || ''), 'utf8').digest('hex');

const asArray = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

export const ingest = onRequest(
  {
    region: 'asia-northeast3',
    // 단축어는 브라우저가 아니라 CORS와 무관하다. 이 목록은 앱의 "연결 확인"
    // 버튼을 위한 것이고, 우리 사이트만 허용한다.
    cors: [/budget-13aec\.web\.app$/, /budget-13aec\.firebaseapp\.com$/],
    maxInstances: 3,
  },
  async (req, res) => {
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'method', 'POST 로 보내 주세요');

      const payload = req.body || {};
      const token = await ingestToken();
      if (String(payload.token || '').trim() !== token) {
        throw new HttpError(401, 'unauthorized', '토큰이 맞지 않아요');
      }

      const whole = String(payload.body || '').trim();
      if (!whole) return res.json({ status: 'ignored', reason: 'empty-body' });

      // 며칠 놓친 문자를 한 건씩 공유하게 둘 수는 없다. 붙여 온 걸 갈라 처리한다.
      const parts = splitMessages(whole);
      if (parts.length > 1) {
        const results = [];
        for (const part of parts) {
          results.push(await takeOne({ ...payload, body: part }));
        }
        return res.json({
          status: 'batch',
          count: results.length,
          saved: results.filter((r) => r.status === 'ok').length,
          duplicate: results.filter((r) => r.status === 'duplicate').length,
          failed: results.filter((r) => r.status === 'parse_failed').length,
          results,
        });
      }

      return res.json(await takeOne({ ...payload, body: parts[0] || whole }));
    } catch (err) {
      const status = err.status || 500;
      res.status(status).json({ ok: false, reason: err.reason || 'error', message: err.message });
    }
  },
);

/** 문자 한 통을 받아 넣는다. 여러 통이 붙어 오면 위에서 갈라 한 통씩 부른다. */
async function takeOne(payload) {
  const body = String(payload.body || '').trim();
  if (!body) return { status: 'ignored', reason: 'empty-body' };

  const uid = await ownerUid();
  const root = db.collection('users').doc(uid);
  const rawId = dedupeId(body);

  // 이미 있는 문자면 아무것도 하지 않는다
  const existing = await root.collection('raw').doc(rawId).get();
  if (existing.exists) return { status: 'duplicate' };

  const receivedAt = payload.receivedAt ? new Date(payload.receivedAt) : new Date();
  const location = (payload.lat !== undefined && payload.lat !== null && payload.lat !== '')
    ? { lat: Number(payload.lat), lon: Number(payload.lon) }
    : null;

  const [patterns, rules, merchants, recent] = await Promise.all([
    root.collection('patterns').get().then(asArray),
    root.collection('rules').get().then(asArray),
    root.collection('merchants').get().then(asArray),
    root.collection('txns').orderBy('occurredAt', 'desc').limit(400).get().then(asArray),
  ]);

  const parsed = parseMessage(body, payload.sender, receivedAt, patterns);

  const raw = {
    body,
    sender: String(payload.sender || ''),
    receivedAt: receivedAt.toISOString(),
    parsedOk: parsed.ok,
    parseNote: parsed.note,
    txnId: null,
    ingestedAt: FieldValue.serverTimestamp(),
  };

  if (parsed.kind === 'ad') {
    await root.collection('raw').doc(rawId).set({ ...raw, parsedOk: true, parseNote: '광고' });
    return { status: 'ignored', reason: 'ad' };
  }
  if (!parsed.ok) {
    await root.collection('raw').doc(rawId).set(raw);
    return { status: 'parse_failed', rawId, note: parsed.note };
  }

  const decision = classify(parsed.merchantRaw, {
    merchants, rules, transactions: recent, location,
  });

  const txnRef = root.collection('txns').doc();
  const txn = buildTransaction(parsed, rawId, location, decision, txnRef.id);

  const batch = db.batch();
  batch.set(root.collection('raw').doc(rawId), { ...raw, txnId: txnRef.id });
  batch.set(txnRef, txn);

  for (const anchor of anchorsFrom(parsed)) {
    batch.set(root.collection('anchors').doc(), { ...anchor, rawId });
  }
  await batch.commit();

  const response = {
    status: txn.categoryId ? 'categorized' : 'uncategorized',
    txnId: txnRef.id,
    merchant: parsed.merchantRaw || '(가맹점 미상)',
    amount: parsed.amount,
    type: txn.type,
    categoryId: txn.categoryId,
    reason: decision.reason,
  };
  if (!txn.categoryId && txn.type === 'expense') {
    response.learnHint = suggestKeyword(parsed.merchantRaw, { rules, transactions: recent });
  }
  return { ...response, status: 'ok', kind: response.status };
}

function buildTransaction(parsed, rawId, location, decision, id) {
  const txn = {
    id,
    type: 'expense',
    amount: parsed.amount,
    currency: 'KRW',
    occurredAt: parsed.occurredAt.toISOString(),
    issuer: parsed.issuer,
    cardName: parsed.cardName,
    accountId: null,          // 화면에서 계정을 정하면 붙는다
    counterAccountId: null,
    categoryId: decision.categoryId || null,
    merchantRaw: parsed.merchantRaw || '',
    merchantId: decision.merchantId || null,
    memo: '',
    payMethod: parsed.installmentMonths > 0 ? 'installment' : 'lump',
    installmentMonths: parsed.installmentMonths || 0,
    status: decision.categoryId ? 'confirmed' : 'pendingCategory',
    source: 'sms',
    rawMessageId: rawId,
    excludeFromBudget: false,
    lat: location?.lat ?? null,
    lon: location?.lon ?? null,
    settlementId: null,
    createdAt: FieldValue.serverTimestamp(),
  };

  if (parsed.kind === 'deposit') {
    txn.type = 'income';
    txn.categoryId = 'cat_salary';
    txn.status = 'confirmed';
  } else if (parsed.kind === 'withdrawal') {
    // 카드 대금 출금은 지출이 아니라 계정 간 이체다.
    // 이걸 지출로 잡으면 매달 카드값만큼 지출이 부풀어 오른다.
    if (/현대\s*카드|카드\s*대금/.test(parsed.merchantRaw || '')) {
      txn.type = 'transfer';
      txn.categoryId = 'cat_cardbill';
      txn.excludeFromBudget = true;
      txn.status = 'confirmed';
    } else if (/ATM|CD기|현금인출/i.test(parsed.merchantRaw || '')) {
      txn.type = 'transfer';
      txn.categoryId = 'cat_withdraw';
      txn.excludeFromBudget = true;
      txn.status = 'confirmed';
    }
  } else if (parsed.kind === 'cancel') {
    // 취소는 지출이 아니다. 지출로 두면 쓴 적 없는 돈이 통계에 남는다.
    // 원래 결제를 찾아 없던 일로 만드는 건 앱에서 한다 — 거기에 지난 거래가 있다.
    txn.type = 'cancel';
    txn.status = 'needsReview';
    txn.categoryId = null;
    txn.excludeFromBudget = true;
  }

  return txn;
}

/** 문자에 찍힌 잔액·누적을 남겨 둔다. 나중에 앱 계산값과 대조해 누락을 잡는다. */
function anchorsFrom(parsed) {
  const at = parsed.occurredAt.toISOString();
  const out = [];
  if (parsed.balance != null) {
    out.push({ at, kind: 'balance', issuer: parsed.issuer, cardName: parsed.cardName,
               reported: parsed.balance, status: 'pending' });
  }
  if (parsed.cumulative != null) {
    out.push({ at, kind: 'cumulative', issuer: parsed.issuer, cardName: parsed.cardName,
               reported: parsed.cumulative, status: 'pending' });
  }
  return out;
}

// ───────────────────────────────────────────────── 위젯이 읽는 곳

/**
 * 잠금화면 위젯이 부르는 창구.
 *
 * 위젯은 사람이 아니라 기계다. 새벽에 주머니 속에서 혼자 돌아 로그인을 못
 * 한다. 그래서 토큰으로 들어온다 — 문자를 넣는 토큰과는 다른 토큰이다.
 *
 * 넣는 토큰이 읽기까지 되면 "넣기만 된다"가 거짓말이 된다. 단축어 설정은
 * 여기저기 돌아다니고, 그 하나가 새면 가계부 전체가 새는 건 다른 얘기다.
 *
 * 그리고 여기서는 합계만 내준다. 어디서 얼마 썼는지는 안 나간다 —
 * 위젯에 띄울 수 있는 건 어차피 숫자 몇 개뿐이다.
 */
async function widgetToken() {
  const snap = await db.doc('config/ingest').get();
  const token = snap.exists ? String(snap.data().widgetToken || '').trim() : '';
  if (!token) throw new HttpError(503, 'no-widget-token', '앱 설정에서 위젯 비밀번호를 정해 주세요');
  return token;
}

export const summary = onRequest(
  { region: 'asia-northeast3', cors: false, maxInstances: 3 },
  async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const given = String(req.query?.token || req.body?.token || '').trim();
      if (!given) throw new HttpError(401, 'no-token', '토큰이 없습니다');
      if (given !== (await widgetToken())) {
        throw new HttpError(401, 'unauthorized', '토큰이 맞지 않습니다');
      }

      const uid = await ownerUid();
      const base = db.collection('users').doc(uid);
      const since = new Date();
      since.setMonth(since.getMonth() - 1);
      since.setDate(1);

      const [txnSnap, accSnap, recSnap, setSnap, rawSnap] = await Promise.all([
        base.collection('txns').where('occurredAt', '>=', since.toISOString()).get(),
        base.collection('accounts').get(),
        base.collection('recurring').get(),
        base.collection('meta').doc('settings').get(),
        base.collection('raw').where('parsedOk', '==', false).get(),
      ]);

      const settings = setSnap.exists ? setSnap.data() : {};
      const transactions = asArray(txnSnap);
      const accounts = asArray(accSnap);

      const L = ledger({ transactions, accounts, recurring: asArray(recSnap),
                         settlements: [], raw: [], settings });
      const spent = monthSpending({ transactions, settlements: [], settings });
      const total = spent.reduce((s, r) => s + (r.counted ? r.net : 0), 0);
      const prev = sameSpanLastMonth({ transactions, settlements: [], settings });
      const run = pace(total, L.month, settings.cycleStartDay);
      const bill = L.cards.items[0] || null;

      res.json({
        ok: true,
        at: new Date().toISOString(),
        month: L.month,
        spent: total,
        budget: L.budget.limit,
        perDay: L.budget.perDay,
        daysLeft: L.budget.daysLeft,
        usedPct: L.budget.usedPct,
        projected: run.projected,
        lastMonthSameSpan: prev.total,
        debt: L.debt.total,
        goalPct: L.goal.pct,
        goalName: L.goal.name,
        nextBill: bill ? { name: bill.name, total: bill.total,
                           payAt: bill.payAt.toISOString().slice(0, 10),
                           daysLeft: bill.daysLeft } : null,
        billTotal: L.cards.total,
        waiting: L.inbox.pending + asArray(rawSnap).filter((r) => !r.txnId).length,
      });
    } catch (err) {
      const status = err.status || 500;
      res.status(status).json({ ok: false, reason: err.reason || 'error', message: err.message });
    }
  },
);
