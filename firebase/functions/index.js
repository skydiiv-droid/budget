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

import { parseMessage, normalizeMerchant } from './shared/parse.js';
import { classify, suggestKeyword } from './shared/classify.js';

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

      const body = String(payload.body || '').trim();
      if (!body) return res.json({ status: 'ignored', reason: 'empty-body' });

      const uid = await ownerUid();
      const root = db.collection('users').doc(uid);
      const rawId = dedupeId(body);

      // 이미 있는 문자면 아무것도 하지 않는다
      const existing = await root.collection('raw').doc(rawId).get();
      if (existing.exists) return res.json({ status: 'duplicate' });

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
        return res.json({ status: 'ignored', reason: 'ad' });
      }
      if (!parsed.ok) {
        await root.collection('raw').doc(rawId).set(raw);
        return res.json({ status: 'parse_failed', rawId, note: parsed.note });
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
      return res.json(response);
    } catch (err) {
      if (err instanceof HttpError) {
        return res.status(err.status).json({ status: 'error', reason: err.reason, message: err.message });
      }
      console.error(err);
      return res.status(500).json({ status: 'error', reason: 'server', message: String(err.message || err) });
    }
  },
);

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
    txn.status = 'needsReview';
    txn.memo = '승인취소 — 원거래를 찾아 상계해야 함';
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
