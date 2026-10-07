/**
 * 고정지출이 제 날짜에 빠져나갔는지 지켜본다.
 *
 * 고정지출도 결국 카드·계좌 문자로 들어온다. 그래서 등록해 둔 항목을 내역에
 * 따로 적어 넣으면 같은 돈이 두 번 세어진다. 등록한 항목이 하는 일은
 * **들어온 문자 중에 이것이 있는지 확인하는 것**이다.
 *
 * 맞춰 보는 단서는 넷이다.
 *   사람이 이은 것 거래의 `recurringId`. 무엇보다 세다
 *   이름 · 키워드  가맹점이나 문자 본문에 그 말이 있는가
 *   결제 수단      어느 계좌·카드에서 빠지는지. 어긋나면 그 건이 아니다
 *   금액           등록액에 가까운가. 근거가 약할 때 받쳐 주고, 여럿일 때 고른다
 *
 * 견줄 때는 양쪽을 똑같이 눕힌다(`flat`). 문자에 찍히는 말은 대소문자도 띄어쓰기도
 * 점도 제각각이라(NETFLIX.COM · Netflix · netflix com) 한쪽만 다듬으면 같은 말을
 * 다른 말로 읽는다.
 *
 * 근거가 약한 것은 금액이나 결제 수단이 받쳐 줘야 받아들인다. 짐작으로
 * "들어왔다"고 해 버리면 안 들어온 것을 안 들어왔다고 말할 수 없게 된다 —
 * 부풀리는 것보다 나쁘다.
 *
 * **한 거래가 두 고정지출을 메우지는 못한다.** 그렇게 두면 이름이 비슷한 둘이
 * 같은 문자 하나로 둘 다 "들어왔다"가 되고, 진짜 안 들어온 쪽이 조용히 묻힌다.
 *
 * 안 들어왔으면 알려 준다. 언제까지 기다리는가:
 *   예정일이 평일이면      그 다음 날까지
 *   예정일이 쉬는 날이면   다음 영업일의 그 다음 날까지
 * 쉬는 날에 걸린 자동이체는 대개 다음 영업일에 빠지므로 하루를 더 준다.
 *
 * 알림에는 반드시 끝이 있어야 한다. 물어보기만 하고 치울 길이 없으면 알림은
 * 영영 남고, 남아 있는 알림은 곧 안 보는 알림이 된다. 그래서 답이 셋이다.
 *   해지했다          `active: false` — 더는 지켜보지 않는다
 *   이 결제건이다     거래에 `recurringId` 를 박는다. 이름이 안 맞아도 이어진다
 *   이번 달은 넘긴다  `skipMonths` 에 그 달을 넣는다
 */

import { nextBusinessDay } from './holidays.js';
import { matchCard } from './accounts.js';

const num = (v) => Number(v || 0);
// 문자에 찍히는 말은 대소문자도 띄어쓰기도 점도 제각각이다 (NETFLIX.COM · netflix com).
// 글자와 숫자만 남겨 견준다.
const flat = (s) => String(s ?? '').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// 한 글자 키워드는 아무 문자에나 걸린다. 두 글자부터 쓴다.
const KEY_MIN = 2;
// 본문 전체를 뒤질 때는 더 길어야 한다. 짧은 말은 카드사 이름이나 안내 문구에 걸린다.
const NAME_MIN = 3;
// 등록액의 반까지는 같은 건으로 본다. 오를 수도 있고 일수에 따라 달라지기도 한다.
const AMOUNT_SLACK = 0.5;

/** 쉼표·줄바꿈으로 적어 둔 키워드를 갈라 놓는다. */
export function parseKeywords(raw) {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  return String(raw ?? '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

/** 지켜볼 고정지출. 해지한 것은 뺀다. */
export const liveRecurring = (list = []) => list.filter((r) => r && r.active !== false);

/** 쓸 만한 키워드만. 한 글자는 버린다. */
const keysOf = (r) => parseKeywords(r?.keywords).map(flat).filter((k) => k.length >= KEY_MIN);

const textOf = (txn) => flat([txn.merchantRaw, txn.memo, txn.rawText].filter(Boolean).join(' '));

/**
 * 문자에 찍힌 가맹점에서 다음 달에 바뀔 꼬리를 떼고 키워드로 삼는다.
 * "넷플릭스서비시스 0915" 를 그대로 배우면 다음 달에는 안 맞는다.
 */
export function learnKeyword(merchantRaw) {
  const raw = String(merchantRaw ?? '')
    .replace(/\(주\)|\(유\)|㈜|주식회사/g, '')
    .trim();
  if (flat(raw).length < KEY_MIN) return '';
  const cut = raw.replace(/[\s*\-_.#]*\d[\d\s\-*/]*$/, '').trim();
  // 떼고 나니 너무 짧아지면 그대로 둔다 — GS25 를 GS 로 배우면 아무 데나 걸린다.
  return flat(cut).length >= NAME_MIN ? cut : raw;
}

/** 그 가맹점명이 이미 이름이나 키워드로 잡히는가. 잡히면 다시 배울 일이 없다. */
export function knownKeyword(r, merchantRaw) {
  const merchant = flat(merchantRaw);
  if (!merchant) return true;
  const name = flat(r?.name);
  if (name && merchant.includes(name)) return true;
  return keysOf(r).some((k) => merchant.includes(k));
}

/**
 * 등록액과 얼마나 벌어졌는가 (0 이면 똑같다). 견줄 수 없으면 null.
 * 금액이 달마다 다른 건은 적어 둔 값이 대략일 뿐이라 견주지 않는다.
 */
function amountGap(txn, r) {
  const expected = num(r.expectedAmount);
  if (!expected || r.amountVaries) return null;
  return Math.abs(num(txn.amount) - expected) / expected;
}

/** 이름·키워드가 걸리는가. 걸리는 방식과 그 근거의 세기를 준다. */
function nameSignal(txn, r) {
  const merchant = flat(txn.merchantRaw);
  const text = textOf(txn);
  const name = flat(r.name);

  if (keysOf(r).some((k) => text.includes(k))) return { by: 'keyword', weak: false };
  if (name && merchant.includes(name)) return { by: 'name', weak: false };
  // 적어 둔 이름이 문자에 찍힌 것보다 길 때 (유튜브프리미엄 ← 유튜브).
  if (name && merchant.length >= NAME_MIN && name.includes(merchant)) return { by: 'part', weak: true };
  // 가맹점 자리를 엉뚱하게 끊어 읽었어도 본문에는 남아 있다 (은행 출금 문자).
  if (name.length >= NAME_MIN && text.includes(name)) return { by: 'text', weak: true };
  return null;
}

/**
 * 결제 수단이 어긋나는가.
 *
 * 정해 뒀으면 거기서 빠진 것만 그 고정지출이다. 다만 어느 계좌인지 모르는
 * 거래까지 쳐내면 멀쩡한 걸 놓치므로 그때는 넘어간다.
 */
function accountFits(txn, r, accounts) {
  if (!r.accountId) return true;
  if (txn.accountId) return txn.accountId === r.accountId;
  if (txn.cardName) {
    const card = matchCard(txn.cardName, accounts);
    if (card) return card.id === r.accountId;
  }
  return true;
}

/**
 * 이 거래가 그 고정지출인가. 맞으면 얼마나 맞는지, 아니면 null.
 * `score` 는 작을수록 잘 맞는 것이다.
 */
export function recurringMatch(txn, r, accounts = [], due = null) {
  if (!txn || !r) return null;
  const days = due ? Math.abs(new Date(txn.occurredAt) - due) / 86400000 : 0;

  // 사람이 손으로 이은 것이 가장 세다. 문자에 찍히는 이름이 매달 달라
  // 어떤 규칙으로도 못 잡는 곳이 있기 때문이다.
  if (txn.recurringId) {
    return txn.recurringId === r.id
      ? { by: 'link', weak: false, gap: amountGap(txn, r), score: -1000 + days }
      : null;
  }

  const sig = nameSignal(txn, r);
  if (!sig) return null;
  if (!accountFits(txn, r, accounts)) return null;

  const gap = amountGap(txn, r);
  if (sig.weak) {
    // 근거가 약한 것은 금액이나 결제 수단이 받쳐 줘야 받는다.
    const backed = (gap !== null && gap <= AMOUNT_SLACK)
      || Boolean(r.accountId && txn.accountId && txn.accountId === r.accountId);
    if (!backed) return null;
  }

  return { ...sig, gap, score: (sig.weak ? 60 : 0) + (gap ?? 0) * 20 + days };
}

/** 이 거래가 그 고정지출인가. */
export const hitsRecurring = (txn, r, accounts = []) =>
  recurringMatch(txn, r, accounts) !== null;

export function dueDateOf(r, yyyymm) {
  const day = Number(r?.dayOfMonth || 0);
  if (!day) return null;
  const [y, m] = String(yyyymm).split('-').map(Number);
  if (!y || !m) return null;
  if (r.period === 'yearly' && Number(r.monthOfYear || 0) !== m) return null;
  const last = new Date(y, m, 0).getDate();
  return new Date(y, m - 1, Math.min(day, last));
}

/**
 * 고정지출 하나하나가 이번 달에 어디까지 왔는지.
 *
 *   paid     들어왔다
 *   waiting  아직 기다릴 때다
 *   late     기다릴 만큼 기다렸는데 안 들어왔다
 *   skipped  이번 달은 넘기기로 했다
 *   ended    해지했다
 *   off      이번 달엔 나갈 것이 아니다 (연 1회가 다른 달)
 *   idle     결제일을 안 적어 둬서 지켜볼 수 없다
 */
export function fixedStatus(data = {}, yyyymm, now = new Date()) {
  const { recurring = [], transactions = [], accounts = [], settings = {} } = data;
  const holidays = settings.extraHolidays || [];
  const month = yyyymm || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const live = transactions.filter((t) => t.status !== 'voided' && t.type !== 'income');

  // ── 지켜볼 수 있는 것과 그 기한 ─────────────────────────
  const rows = recurring.map((r) => {
    const due = dueDateOf(r, month);
    const row = {
      id: r.id, name: r.name, recurring: r,
      expected: num(r.expectedAmount),
      varies: Boolean(r.amountVaries),
      accountId: r.accountId || '',
      keywords: parseKeywords(r.keywords),
      due: null, settled: null, deadline: null, shifted: false,
      txn: null, amount: 0, diff: 0, daysLate: 0,
      by: '', loose: false, state: 'idle', watch: false,
    };

    if (r.active === false) return { ...row, due, state: 'ended' };
    if (!Number(r.dayOfMonth || 0)) return row;
    if (!due) return { ...row, state: 'off' };

    // 쉬는 날에 걸린 자동이체는 다음 영업일에 빠진다. 거기서 하루를 더 기다린다.
    const settled = nextBusinessDay(due, holidays);
    const deadline = new Date(settled.getFullYear(), settled.getMonth(), settled.getDate() + 1, 23, 59, 59, 999);
    return { ...row, due, settled, deadline, shifted: ymd(settled) !== ymd(due), watch: true };
  });

  // ── 거래를 하나씩 나눠 준다 ─────────────────────────────
  // 한 거래가 두 고정지출을 메우지는 못한다. 그렇게 두면 이름이 비슷한 둘이
  // 문자 하나로 둘 다 "들어왔다"가 되고, 진짜 안 들어온 쪽이 조용히 묻힌다.
  const taken = new Map();          // 거래 id → 고정지출 id
  const got = new Map();            // 고정지출 id → { txn, by, weak }

  // 손으로 이은 건이 먼저다. 기한 밖이어도 받아들인다 — 사람이 보고 고른 것이니까.
  for (const row of rows) {
    if (!row.watch) continue;
    const hit = live
      .filter((t) => t.recurringId === row.id && !taken.has(t.id) && inSpan(t, row.due))
      .sort((a, b) => Math.abs(new Date(a.occurredAt) - row.due) - Math.abs(new Date(b.occurredAt) - row.due))[0];
    if (hit) { taken.set(hit.id, row.id); got.set(row.id, { txn: hit, by: 'link', weak: false }); }
  }

  // 나머지는 잘 맞는 순으로 나눈다. 예정일보다 며칠 일찍 빠지는 곳도 있어서
  // 앞으로 사흘까지는 같은 건으로 본다.
  const pool = [];
  for (const row of rows) {
    if (!row.watch || got.has(row.id)) continue;
    const from = new Date(row.due.getFullYear(), row.due.getMonth(), row.due.getDate() - 3).getTime();
    for (const t of live) {
      if (t.recurringId || taken.has(t.id)) continue;
      const at = new Date(t.occurredAt).getTime();
      if (at < from || at > row.deadline.getTime()) continue;
      const m = recurringMatch(t, row.recurring, accounts, row.due);
      if (m) pool.push({ id: row.id, txn: t, m });
    }
  }
  pool.sort((a, b) => a.m.score - b.m.score
    || String(a.txn.occurredAt).localeCompare(String(b.txn.occurredAt)));
  for (const c of pool) {
    if (got.has(c.id) || taken.has(c.txn.id)) continue;
    got.set(c.id, { txn: c.txn, by: c.m.by, weak: c.m.weak });
    taken.set(c.txn.id, c.id);
  }

  return rows.map(({ watch, ...row }) => {
    if (!watch) return row;
    const hit = got.get(row.id) || null;
    const r = row.recurring;
    const amount = hit ? num(hit.txn.amount) : 0;
    const skipped = (r.skipMonths || []).includes(month);
    const state = hit ? 'paid' : skipped ? 'skipped' : (now > row.deadline ? 'late' : 'waiting');

    return {
      ...row,
      txn: hit ? hit.txn : null,
      amount,
      by: hit ? hit.by : '',
      // 이름이 일부만 맞아 금액으로 받친 건. 그렇게 잡았다고 말해 줘야 한다.
      loose: Boolean(hit && hit.weak),
      // 금액이 달마다 다른 건은 견줄 것이 없다. 대략 적어 둔 값일 뿐이다.
      diff: hit && !r.amountVaries ? amount - num(r.expectedAmount) : 0,
      daysLate: state === 'late' ? Math.floor((now - row.deadline) / 86400000) + 1 : 0,
      state,
    };
  });
}

/** 기다릴 만큼 기다렸는데 안 들어온 것들. 늦은 순. */
export const lateFixed = (rows = []) => rows
  .filter((r) => r.state === 'late')
  .sort((a, b) => b.daysLate - a.daysLate);

/** 한 주기로 볼 범위. 예정일 앞 열흘부터 뒤 스무날까지. */
const SPAN_BEFORE = 10;
const SPAN_AFTER = 20;
function inSpan(txn, due) {
  if (!due) return false;
  const at = new Date(txn.occurredAt).getTime();
  const from = new Date(due.getFullYear(), due.getMonth(), due.getDate() - SPAN_BEFORE).getTime();
  const to = new Date(due.getFullYear(), due.getMonth(), due.getDate() + SPAN_AFTER, 23, 59, 59, 999).getTime();
  return at >= from && at <= to;
}

/**
 * "출금됐다"고 할 때 고를 만한 거래.
 *
 * 금액이 가깝고 날짜가 가까운 순. 금액이 달마다 다른 건은 날짜만 본다 —
 * 견줄 금액이 없으니 금액 차이로 줄을 세우면 엉뚱한 게 앞에 온다.
 */
export function candidates(r, transactions = [], yyyymm, limit = 8) {
  const due = dueDateOf(r, yyyymm);
  if (!due) return [];

  return transactions
    // 저축으로 돌리는 자동이체는 `transfer` 다. 지출만 보여 주면 그 건은
    // 목록에 아예 안 떠서 "출금됐다"고 답할 길이 없어진다.
    .filter((t) => t.status !== 'voided' && t.type !== 'income')
    .filter((t) => !t.recurringId || t.recurringId === r.id)
    .filter((t) => inSpan(t, due))
    .map((t) => {
      const days = Math.abs(new Date(t.occurredAt) - due) / 86400000;
      const gap = amountGap(t, r) ?? 0;
      // 이름이나 키워드가 걸리는 건은 위로 올린다
      const named = nameSignal(t, r) ? -8 : 0;
      return { t, score: gap * 20 + days + named };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((x) => x.t);
}
