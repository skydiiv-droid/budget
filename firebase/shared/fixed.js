/**
 * 고정지출이 제 날짜에 빠져나갔는지 지켜본다.
 *
 * 고정지출도 결국 카드·계좌 문자로 들어온다. 그래서 등록해 둔 항목을 내역에
 * 따로 적어 넣으면 같은 돈이 두 번 세어진다. 등록한 항목이 하는 일은
 * **들어온 문자 중에 이것이 있는지 확인하는 것**이다.
 *
 * 확인에 쓰는 단서는 셋이다.
 *   이름      "넷플릭스" 가 가맹점에 들어 있으면 그것이다
 *   키워드    문자에 찍히는 말이 이름과 다를 때 쓴다 (넷플릭스 → NETFLIX.COM)
 *   결제 수단 어느 계좌·카드에서 빠지는지. 정해 두면 다른 데서 긁힌 건 아니다
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

import { normalizeMerchant } from './parse.js';
import { nextBusinessDay } from './holidays.js';
import { matchCard } from './accounts.js';

const num = (v) => Number(v || 0);
// 문자에 찍히는 말은 띄어쓰기도 점도 제각각이다 (NETFLIX.COM · netflix com).
// 글자와 숫자만 남겨 견준다.
const flat = (s) => String(s ?? '').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 쉼표·줄바꿈으로 적어 둔 키워드를 갈라 놓는다. */
export function parseKeywords(raw) {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  return String(raw ?? '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

/** 지켜볼 고정지출. 해지한 것은 뺀다. */
export const liveRecurring = (list = []) => list.filter((r) => r && r.active !== false);

/**
 * 이 거래가 그 고정지출인가.
 *
 * 사람이 손으로 이어 붙인 것이 가장 세다. 문자에 찍히는 이름이 매달 달라
 * 어떤 규칙으로도 못 잡는 곳이 있기 때문이다.
 */
export function hitsRecurring(txn, r, accounts = []) {
  if (!txn || !r) return false;
  if (txn.recurringId) return txn.recurringId === r.id;

  const text = flat([txn.merchantRaw, txn.memo, txn.rawText].filter(Boolean).join(' '));
  const merchant = normalizeMerchant(txn.merchantRaw);

  const name = normalizeMerchant(r.name);
  const keywords = parseKeywords(r.keywords);
  const named = (name && merchant.includes(name))
    || keywords.some((k) => flat(k) && text.includes(flat(k)));
  if (!named) return false;

  // 결제 수단을 정해 뒀으면 거기서 빠진 것만 그 고정지출이다. 다만 어느
  // 계좌인지 모르는 거래까지 쳐내면 멀쩡한 걸 놓치므로 그때는 넘어간다.
  if (!r.accountId) return true;
  if (txn.accountId) return txn.accountId === r.accountId;
  if (txn.cardName) {
    const card = matchCard(txn.cardName, accounts);
    if (card) return card.id === r.accountId;
  }
  return true;
}

/**
 * 이번 주기에 이 고정지출이 빠져나갈 날.
 *
 * 연 1회짜리는 해당 월에만 날이 있다. 결제일을 안 적어 뒀으면 날을 못 잡으므로
 * 지켜보지 않는다.
 */
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

  return recurring.map((r) => {
    const due = dueDateOf(r, month);
    const row = {
      id: r.id, name: r.name, recurring: r,
      expected: num(r.expectedAmount),
      varies: Boolean(r.amountVaries),
      accountId: r.accountId || '',
      keywords: parseKeywords(r.keywords),
      due: null, settled: null, deadline: null, shifted: false,
      txn: null, amount: 0, diff: 0, daysLate: 0, state: 'idle',
    };

    if (r.active === false) return { ...row, due, state: 'ended' };
    if (!Number(r.dayOfMonth || 0)) return row;
    if (!due) return { ...row, state: 'off' };

    // 쉬는 날에 걸린 자동이체는 다음 영업일에 빠진다. 거기서 하루를 더 기다린다.
    const settled = nextBusinessDay(due, holidays);
    const deadline = new Date(settled.getFullYear(), settled.getMonth(), settled.getDate() + 1, 23, 59, 59, 999);

    // 예정일보다 며칠 일찍 빠지는 곳도 있어서 앞으로 사흘까지는 같은 건으로 본다.
    const from = new Date(due.getFullYear(), due.getMonth(), due.getDate() - 3).getTime();
    const auto = live
      .filter((t) => !t.recurringId && hitsRecurring(t, r, accounts))
      .filter((t) => {
        const at = new Date(t.occurredAt).getTime();
        return at >= from && at <= deadline.getTime();
      })
      .sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)))[0] || null;

    // 손으로 이어 붙인 건은 기한 밖이어도 받아들인다. 사람이 보고 고른 것이니까.
    const linked = live
      .filter((t) => t.recurringId === r.id)
      .filter((t) => inSpan(t, due))
      .sort((a, b) => Math.abs(new Date(a.occurredAt) - due) - Math.abs(new Date(b.occurredAt) - due))[0] || null;

    const hit = linked || auto;
    const amount = hit ? num(hit.amount) : 0;
    const skipped = (r.skipMonths || []).includes(month);
    const state = hit ? 'paid' : skipped ? 'skipped' : (now > deadline ? 'late' : 'waiting');

    return {
      ...row,
      due, settled, deadline,
      shifted: ymd(settled) !== ymd(due),
      txn: hit, amount,
      // 금액이 달마다 다른 건은 견줄 것이 없다. 대략 적어 둔 값일 뿐이다.
      diff: hit && !r.amountVaries ? amount - num(r.expectedAmount) : 0,
      daysLate: state === 'late' ? Math.floor((now - deadline) / 86400000) + 1 : 0,
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
  const expected = num(r?.expectedAmount);
  const useAmount = expected > 0 && !r?.amountVaries;

  return transactions
    .filter((t) => t.type === 'expense' && t.status !== 'voided')
    .filter((t) => !t.recurringId || t.recurringId === r.id)
    .filter((t) => inSpan(t, due))
    .map((t) => {
      const days = Math.abs(new Date(t.occurredAt) - due) / 86400000;
      const off = useAmount ? Math.abs(num(t.amount) - expected) / expected : 0;
      return { t, score: off * 20 + days };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((x) => x.t);
}
